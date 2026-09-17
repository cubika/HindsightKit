"""Read the current WorkIQ mailbox and prepare complete, clean mail sources."""
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import datetime
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit


WORKIQ_VERSION = "1.0.0"
WORKIQ_SHA256 = "cefffb1983ad15da3d98630f597ca69db026273ed97d0d49000360f9a4d20540"
CLEANUP_VERSION = 1
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_TEXT_BYTES = 128 * 1024
METADATA_FIELDS = "id,internetMessageId,conversationId,receivedDateTime,sentDateTime,lastModifiedDateTime,from,subject,isDraft,parentFolderId"
FOLDER_FIELDS = "id,displayName,parentFolderId,childFolderCount"


class WorkIQError(RuntimeError):
    """Safe error code: upstream messages can contain private mail or credentials."""

    def __init__(self, code, status=None):
        super().__init__(code)
        self.code = code
        self.status = status


def _safe_transport_error(error):
    pending, errors = [error], []
    while pending:
        current = pending.pop()
        if isinstance(current, WorkIQError):
            errors.append(current)
        elif isinstance(current, BaseExceptionGroup):
            pending.extend(reversed(current.exceptions))
    if not errors:
        return WorkIQError("workiq_transport_failed")
    selected = next((item for item in errors if item.code == "workiq_eula_required"),
                    next((item for item in errors if item.status in {401, 403}), errors[0]))
    return WorkIQError(selected.code, selected.status)


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def source_key(message, mailbox_id):
    internet_id = message.get("internetMessageId")
    if not mailbox_id or not isinstance(internet_id, str) or not re.fullmatch(r"<[^<>\s]+@[^<>\s]+>", internet_id):
        raise WorkIQError("workiq_message_identity_missing")
    return "mail-" + _hash([mailbox_id.casefold(), internet_id])


def source_version(message):
    modified = message.get("lastModifiedDateTime")
    _date(modified)
    return _hash([CLEANUP_VERSION, message.get("internetMessageId"), modified, message.get("subject", "")])


def _identifier(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or re.search(r"[\x00-\x20\x7f]", value) or value in {".", ".."}:
        raise WorkIQError("workiq_identifier_invalid")
    return quote(value, safe="")


def _date(value):
    try:
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)", value):
            raise ValueError
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError
        return result
    except (ValueError, TypeError):
        raise WorkIQError("workiq_date_invalid") from None


def _metadata(value, *, require_identity=True):
    if not isinstance(value, dict):
        raise WorkIQError("workiq_message_invalid")
    for field in ("id", "parentFolderId"):
        _identifier(value.get(field))
    _date(value.get("receivedDateTime"))
    source_version(value)
    if not isinstance(value.get("isDraft"), bool) or not isinstance(value.get("subject", ""), str):
        raise WorkIQError("workiq_message_invalid")
    if require_identity:
        source_key(value, "verified")
    return value


def find_workiq(binary=None):
    """Reuse a verified native executable. Never install or execute an npm shim."""
    candidates = []
    if binary:
        candidates.append(Path(binary))
    else:
        executable = shutil.which("workiq") or shutil.which("workiq.cmd") or shutil.which("workiq.ps1")
        if executable:
            path = Path(executable)
            if path.suffix.lower() == ".exe":
                candidates.append(path)
            candidates.append(path.parent / "node_modules/@microsoft/workiq/bin/win-x64/workiq.exe")
        candidates.append(Path(os.environ.get("APPDATA", "")) / "npm/node_modules/@microsoft/workiq/bin/win-x64/workiq.exe")
    for path in candidates:
        if path.is_file() and path.suffix.lower() == ".exe":
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest == WORKIQ_SHA256:
                return str(path.resolve())
    raise WorkIQError("workiq_1_0_0_not_found" if not binary else "workiq_binary_unverified")


def _unpack(result, count, allow_missing=False):
    if hasattr(result, "model_dump"):
        result = result.model_dump(by_alias=True)
    if not isinstance(result, dict):
        raise WorkIQError("workiq_tool_failed")
    if result.get("isError") or result.get("is_error"):
        blocks = result.get("content")
        if isinstance(blocks, list) and any(
                isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
                and "you must accept the eula before using this tool." in block["text"].lower() for block in blocks):
            raise WorkIQError("workiq_eula_required")
        raise WorkIQError("workiq_tool_failed")
    payload = result.get("structuredContent") or result.get("structured_content")
    if payload is None:
        blocks = result.get("content", [])
        if len(blocks) != 1 or blocks[0].get("type") != "text":
            raise WorkIQError("workiq_response_invalid")
        try:
            payload = json.loads(blocks[0]["text"])
        except (ValueError, KeyError, TypeError):
            raise WorkIQError("workiq_response_invalid") from None
    if len(json.dumps(payload)) > 8 * 1024 * 1024:
        raise WorkIQError("workiq_response_too_large")
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list) or len(results) != count:
        raise WorkIQError("workiq_response_count_mismatch")
    output = []
    for item in results:
        status = item.get("statusCode") if isinstance(item, dict) else None
        data = item.get("data") if isinstance(item, dict) else None
        if status == 404 and allow_missing:
            output.append({"_workiq_error": "workiq_message_unavailable"})
            continue
        if not isinstance(status, int) or not 200 <= status < 300 or item.get("error"):
            raise WorkIQError("workiq_fetch_failed", status)
        if not isinstance(data, dict) or data.get("error"):
            raise WorkIQError("workiq_response_invalid", status)
        output.append(data)
    return output


def validate_next_link(link, path, fields, filter_text=None, page_size=100):
    """Keep opaque cursor bytes, while restricting the origin, collection and window."""
    if not isinstance(link, str) or len(link) > 32768 or re.search(r"[\x00-\x20\x7f\\]", link):
        raise WorkIQError("workiq_next_link_invalid")
    url = urlsplit(link)
    if (url.scheme and url.scheme != "https") or (url.netloc and url.netloc != "graph.microsoft.com") or url.fragment:
        raise WorkIQError("workiq_next_link_outside_scope")
    supplied = url.path.removeprefix("/v1.0")
    # Graph returns OData syntax that WorkIQ only accepts as an equivalent slash path.
    supplied = re.sub(r"/mailFolders\('((?:''|[^'])*)'\)", lambda m: "/mailFolders/" + quote(unquote(m[1]).replace("''", "'"), safe=""), supplied)
    if supplied != path or not url.query:
        raise WorkIQError("workiq_next_link_outside_scope")
    entries = parse_qsl(url.query, keep_blank_values=True)
    query = dict(entries)
    allowed = {"$select", "$top", "$skip", "$skiptoken", "$filter", "$orderby"}
    if len(query) != len(entries) or not set(query) <= allowed:
        raise WorkIQError("workiq_next_link_query_invalid")
    if query.get("$select") != fields or query.get("$filter") != filter_text:
        raise WorkIQError("workiq_next_link_outside_scope")
    if not (query.get("$skiptoken") or re.fullmatch(r"\d+", query.get("$skip", ""))):
        raise WorkIQError("workiq_next_link_cursor_missing")
    if "$top" in query and (not query["$top"].isdigit() or not 1 <= int(query["$top"]) <= page_size):
        raise WorkIQError("workiq_next_link_query_invalid")
    if "$skip" in query and not query["$skip"].isdigit():
        raise WorkIQError("workiq_next_link_query_invalid")
    if "$orderby" in query and query["$orderby"] not in {"receivedDateTime", "receivedDateTime asc", "receivedDateTime desc"}:
        raise WorkIQError("workiq_next_link_query_invalid")
    return path + "?" + url.query


def recommended_folders(folders):
    by_id = {folder["id"]: folder for folder in folders}
    compact = lambda name: re.sub(r"[\s_-]", "", name).casefold()
    roots = {folder["id"] for folder in folders if compact(folder["name"]) == "dsapisot"}
    inbox = {folder["id"] for folder in folders if compact(folder["name"]) in {"inbox", "收件箱"}}
    for folder in folders:
        chain, seen = [], set()
        current = folder
        while current and current["id"] not in seen:
            chain.append(current)
            seen.add(current["id"])
            current = by_id.get(current.get("parent_id"))
        in_dsapi = any(node["id"] in roots for node in chain)
        excluded = in_dsapi and any(compact(node["name"]) in {"sev3", "pullrequests"} for node in chain)
        folder["excluded"] = excluded
        folder["selected"] = folder["recommended"] = (folder["id"] in inbox or in_dsapi) and not excluded
    return (["Inbox"] if not inbox else []) + (["DSAPISOT"] if not roots else [])


class WorkIQMailSource:
    def __init__(self, binary=None, page_size=50, concurrency=4, timeout=45,
                 max_thread_messages=100, max_thread_chars=100_000):
        if not 1 <= page_size <= 100 or not 1 <= concurrency <= 8 or not 1 <= timeout <= 120:
            raise ValueError("Invalid WorkIQ read limits")
        self.binary, self.page_size, self.concurrency, self.timeout = binary, page_size, concurrency, timeout
        if not 1 <= max_thread_messages <= 500 or not 1000 <= max_thread_chars <= 500_000:
            raise ValueError("Invalid thread limits")
        self.max_thread_messages, self.max_thread_chars = max_thread_messages, max_thread_chars
        self._owner = self._queue = self._ready = self._account = None
        self._folders = None

    async def __aenter__(self):
        self._queue = asyncio.Queue()
        self._ready = asyncio.get_running_loop().create_future()
        self._owner = asyncio.create_task(self._serve())
        try:
            await self._ready
        except BaseException:
            await self.close()
            raise
        return self

    @asynccontextmanager
    async def _session(self, binary, account=None):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        async with AsyncExitStack() as stack:
            err = stack.enter_context(open(os.devnull, "w"))
            args = ["mcp", "--log-level", "None"] + (["--account", account] if account else [])
            params = StdioServerParameters(command=binary, args=args, env=dict(os.environ))
            read, write = await stack.enter_async_context(stdio_client(params, errlog=err))
            session = await stack.enter_async_context(ClientSession(read, write))
            await asyncio.wait_for(session.initialize(), self.timeout)
            listing = await asyncio.wait_for(session.list_tools(), self.timeout)
            fetch = [tool for tool in listing.tools if tool.name == "fetch"]
            schema = fetch[0].input_schema if len(fetch) == 1 else {}
            prop = schema.get("properties", {}).get("entityUrls", {})
            if prop.get("type") != "array" or prop.get("items", {}).get("type") != "string" or schema.get("required") != ["entityUrls"]:
                raise WorkIQError("workiq_fetch_schema_changed")
            yield session

    async def _read_account(self, session):
        result = await session.call_tool("fetch", {"entityUrls": ["/me?$select=id,mail,userPrincipalName"]}, read_timeout_seconds=self.timeout)
        value, = _unpack(result, 1)
        _identifier(value.get("id"))
        upn = value.get("userPrincipalName")
        if not isinstance(upn, str) or len(upn) > 320 or not re.fullmatch(r"[^\s@]+@[^\s@]+", upn):
            raise WorkIQError("workiq_account_invalid")
        account = {key: value.get(key) for key in ("id", "mail", "userPrincipalName")}
        if self._account and account != self._account:
            raise WorkIQError("workiq_account_changed")
        return account

    async def _serve(self):
        # One owner task keeps AnyIO enter/exit paired. Discover the default
        # identity once, then bind every mailbox read to that exact account.
        try:
            binary = find_workiq(self.binary)
            async with self._session(binary) as discovery:
                self._account = await self._read_account(discovery)
            async with self._session(binary, self._account["userPrincipalName"]) as session:
                await self._read_account(session)
                self._ready.set_result(None)
                while True:
                    request = await self._queue.get()
                    if request is None:
                        break
                    paths, future, allow_missing = request
                    if future.done():
                        continue
                    try:
                        if paths is None:
                            async with self._session(binary) as current:
                                values = await self._read_account(current)
                        else:
                            result = await session.call_tool("fetch", {"entityUrls": paths}, read_timeout_seconds=self.timeout)
                            values = _unpack(result, len(paths), allow_missing)
                    except Exception as error:
                        if not future.done():
                            future.set_exception(_safe_transport_error(error))
                    else:
                        if not future.done():
                            future.set_result(values)
        except Exception as error:
            failure = _safe_transport_error(error)
            if not self._ready.done():
                self._ready.set_exception(failure)
            while not self._queue.empty():
                request = self._queue.get_nowait()
                if request and not request[1].done():
                    request[1].set_exception(failure)

    async def __aexit__(self, *args):
        await self.close()

    async def close(self):
        owner, self._owner = self._owner, None
        if owner:
            await self._queue.put(None)
            await owner

    async def _fetch(self, paths, allow_missing=False):
        if self._owner is None or self._owner.done():
            raise WorkIQError("workiq_not_connected")
        future = asyncio.get_running_loop().create_future()
        await self._queue.put((paths, future, allow_missing))
        return await future

    async def account(self):
        # Called at scan/preview boundaries, not for each page. A new unbound
        # session detects a changed default while the read session stays bound.
        return dict(await self._fetch(None))

    async def folders(self):
        await self.account()
        folders, pending, seen, links = [], [("/me/mailFolders", "", None)], set(), set()
        while pending:
            path, label, parent_id = pending.pop(0)
            link = path + "?" + urlencode({"$select": FOLDER_FIELDS, "$top": 100})
            while link:
                if link in links or len(links) >= 200 or len(folders) > 2000:
                    raise WorkIQError("workiq_folder_listing_incomplete")
                links.add(link)
                page, = await self._fetch([link])
                if not isinstance(page.get("value"), list) or len(page["value"]) > 100:
                    raise WorkIQError("workiq_folder_response_invalid")
                for raw in page["value"]:
                    _identifier(raw.get("id"))
                    if raw["id"] in seen or not isinstance(raw.get("displayName"), str) or not isinstance(raw.get("childFolderCount"), int) or raw["childFolderCount"] < 0:
                        raise WorkIQError("workiq_folder_response_invalid")
                    if parent_id and raw.get("parentFolderId") != parent_id:
                        raise WorkIQError("workiq_folder_parent_changed")
                    seen.add(raw["id"])
                    folder = {"id": raw["id"], "name": raw["displayName"], "path": label + raw["displayName"], "parent_id": raw.get("parentFolderId")}
                    folders.append(folder)
                    if raw["childFolderCount"] > 0:
                        pending.append(("/me/mailFolders/" + _identifier(raw["id"]) + "/childFolders", folder["path"] + " / ", raw["id"]))
                link = validate_next_link(page["@odata.nextLink"], path, FOLDER_FIELDS) if "@odata.nextLink" in page else None
        recommended_folders(folders)
        self._folders = {folder["id"]: folder for folder in folders}
        return folders

    async def discover(self):
        folders = await self.folders()
        return {"account": dict(self._account), "folders": folders, "unresolved": recommended_folders(folders)}

    async def page(self, folder_id, from_iso, to_iso, next_link=None):
        start, end = _date(from_iso), _date(to_iso)
        if start >= end:
            raise WorkIQError("workiq_window_invalid")
        path = "/me/mailFolders/" + _identifier(folder_id) + "/messages"
        filter_text = f"receivedDateTime ge {from_iso} and receivedDateTime lt {to_iso}"
        link = validate_next_link(next_link, path, METADATA_FIELDS, filter_text, self.page_size) if next_link else path + "?" + urlencode({"$filter": filter_text, "$select": METADATA_FIELDS, "$top": self.page_size})
        page, = await self._fetch([link])
        if not isinstance(page.get("value"), list) or len(page["value"]) > self.page_size or "@odata.deltaLink" in page:
            raise WorkIQError("workiq_page_invalid")
        # Discovery records unusable mail identities after validating the page scope.
        messages = [_metadata(value, require_identity=False) for value in page["value"]]
        seen = set()
        for message in messages:
            if message["id"] in seen or message["parentFolderId"] != folder_id or not start <= _date(message["receivedDateTime"]) < end:
                raise WorkIQError("workiq_message_outside_scope")
            seen.add(message["id"])
        next_link = validate_next_link(page["@odata.nextLink"], path, METADATA_FIELDS, filter_text, self.page_size) if "@odata.nextLink" in page else None
        return {"messages": messages, "next_link": next_link}

    async def messages(self, metadata):
        if not self._account:
            raise WorkIQError("workiq_not_connected")
        output = []
        for offset in range(0, len(metadata), self.concurrency):
            batch = [_metadata(item) for item in metadata[offset:offset + self.concurrency]]
            paths = ["/me/mailFolders/" + _identifier(item["parentFolderId"]) + "/messages/" + _identifier(item["id"]) + "?$select=" + METADATA_FIELDS + ",body,webLink" for item in batch]
            for previous, raw in zip(batch, await self._fetch(paths, allow_missing=True)):
                if raw.get("_workiq_error"):
                    output.append(_failed_message(previous, self._account["id"], raw["_workiq_error"]))
                    continue
                _metadata(raw)
                if any(raw.get(key) != previous.get(key) for key in ("id", "internetMessageId", "conversationId", "parentFolderId", "receivedDateTime")):
                    raise WorkIQError("workiq_message_changed")
                try:
                    output.append(normalize_message(raw, self._account["id"]))
                except WorkIQError as error:
                    if error.code not in {"workiq_complete_body_missing", "workiq_body_too_large", "workiq_protected_body_unavailable"}:
                        raise
                    output.append(_failed_message(raw, self._account["id"], error.code))
        return output


    async def thread(self, conversation_id, folder_ids, before_iso):
        """Read the complete selected-folder thread, or fail without a partial result."""
        _identifier(conversation_id)
        end = _date(before_iso)
        if not isinstance(folder_ids, (list, tuple)) or not folder_ids:
            raise WorkIQError("workiq_thread_scope_missing")
        if self._folders is None:
            await self.folders()
        selected = list(dict.fromkeys(folder_ids))
        if any(folder not in self._folders or self._folders[folder].get("excluded") for folder in selected):
            raise WorkIQError("workiq_thread_folder_excluded")
        conversation = conversation_id.replace("'", "''")
        filter_text = f"receivedDateTime lt {before_iso} and conversationId eq '{conversation}'"
        metadata, seen, graph_ids, links = [], set(), set(), set()
        pending = []
        for folder_id in selected:
            path = "/me/mailFolders/" + _identifier(folder_id) + "/messages"
            link = path + "?" + urlencode({"$filter": filter_text, "$select": METADATA_FIELDS, "$top": self.page_size})
            pending.append((folder_id, path, link))
        while pending:
            for _, _, link in pending:
                if link in links or len(links) >= self.max_thread_messages + len(selected):
                    raise WorkIQError("workiq_thread_incomplete")
                links.add(link)
            pages = await self._fetch([link for _, _, link in pending])
            if len(pages) != len(pending):
                raise WorkIQError("workiq_thread_response_invalid")
            next_pages = []
            for (folder_id, path, _), page in zip(pending, pages):
                if not isinstance(page.get("value"), list) or len(page["value"]) > self.page_size or "@odata.deltaLink" in page:
                    raise WorkIQError("workiq_thread_response_invalid")
                for item in page["value"]:
                    _metadata(item, require_identity=False)
                    if item.get("conversationId") != conversation_id or item["parentFolderId"] != folder_id or _date(item["receivedDateTime"]) >= end:
                        raise WorkIQError("workiq_thread_outside_scope")
                    if item["id"] in graph_ids:
                        raise WorkIQError("workiq_thread_changed")
                    graph_ids.add(item["id"])
                    if len(graph_ids) > self.max_thread_messages:
                        raise WorkIQError("workiq_thread_too_large")
                    if item["isDraft"]:
                        continue
                    source_key(item, "verified")
                    identity = item["internetMessageId"]
                    if identity in seen:
                        raise WorkIQError("workiq_thread_changed")
                    seen.add(identity)
                    metadata.append(item)
                if "@odata.nextLink" in page:
                    link = validate_next_link(page["@odata.nextLink"], path, METADATA_FIELDS, filter_text, self.page_size)
                    next_pages.append((folder_id, path, link))
            pending = next_pages
        if not metadata:
            raise WorkIQError("workiq_thread_missing")
        messages = await self.messages(metadata)
        if len(messages) != len(metadata) or any(message.get("error") or not message.get("source_text", "").strip() for message in messages):
            raise WorkIQError("workiq_thread_incomplete")
        if sum(len(message["content"]) for message in messages) > self.max_thread_chars:
            raise WorkIQError("workiq_thread_too_large")
        for message in messages:
            folder = self._folders[message['metadata']['folder_id']]
            if folder.get('path'):
                message['metadata']['folder_path'] = folder['path']
        messages.sort(key=lambda message: (_date(message["metadata"].get("sent_at") or message["metadata"]["received_at"]), message["source_key"]))
        return messages


class _MailHTML(HTMLParser):
    BLOCKS = {"div", "p", "br", "li", "tr", "table", "section", "h1", "h2", "h3", "hr", "blockquote"}
    HIDDEN = {"script", "style", "head", "noscript", "iframe", "object", "svg", "canvas"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.output, self.hidden = [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        style = re.sub(r"\s", "", attrs.get("style", "").casefold())
        hidden = tag in self.HIDDEN or "hidden" in attrs or attrs.get("aria-hidden") == "true" or "display:none" in style or "visibility:hidden" in style
        if self.hidden or hidden:
            if tag not in {"br", "hr", "img", "input", "meta", "link", "wbr", "source"}:
                self.hidden.append(tag)
        elif tag in self.BLOCKS:
            self.output.append("\n")
        elif tag in {"td", "th"}:
            self.output.append("\t")

    def handle_endtag(self, tag):
        if self.hidden:
            if tag in self.hidden:
                del self.hidden[len(self.hidden) - 1 - self.hidden[::-1].index(tag):]
        elif tag in self.BLOCKS:
            self.output.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.output.append(data)


def html_to_text(value):
    parser = _MailHTML()
    parser.feed(value)
    parser.close()
    return "".join(parser.output)


_HEADER = re.compile(r"^\s*(From|Sent|Date|To|Cc|Bcc|Subject|发件人|寄件者|发送时间|傳送時間|寄件日期|收件人|收件者|抄送|副本|密送|主题|主旨)\s*[:：]\s*(.*)$", re.I)
_FROM = re.compile(r"^(From|发件人|寄件者)$", re.I)
_SUBJECT = re.compile(r"^(Subject|主题|主旨)$", re.I)
_SIGNOFF = re.compile(r"^(?:--|thanks|thank you|regards|best(?: regards)?|kind regards|cheers|谢谢|感谢|此致)[,，!！.。\s]*$", re.I)
_DISCLAIMER = re.compile(r"^(?:This (?:e-?mail|message)(?: and any attachments)? (?:is (?:confidential|intended)|contains confidential)|The information contained in this (?:e-?mail|message)|Confidentiality notice|Disclaimer:|本邮件(?:及其附件)?(?:仅供|包含保密)|此邮件(?:及附件)?(?:仅供|包含机密))", re.I)
_COURTESY = re.compile(r"^(?:(?:thanks|thank you(?: very much)?|fyi|got it|noted|sounds good|thank you for (?:the )?(?:update|sharing)|谢谢|收到|感谢)[,!.。！\s]*)+$", re.I)
_FOOTER = re.compile(r"^(?:We sent you this notification due to|Microsoft respects your privacy|One Microsoft Way, Redmond|Sent from Azure DevOps|Classified as Microsoft (?:Confidential|Internal)|View comment\s+Open in CodeFlow|View\s*\|\s*Unsubscribe)", re.I)
_TEAMS = re.compile(r"^(?:Microsoft Teams (?:meeting|会议|Need help\?)|Join(?: the meeting now)?[: ]|Meeting ID:|Passcode:|Need help\?|For organizers:|Dial in by phone|Phone conference ID:|加入[:：]|会议 ID[:：]|密码[:：]|是否需要帮助[?？]|对于组织者[:：]|_{8,}$)", re.I)


def _signature(lines):
    tail = [part for part in lines if part]
    if not tail:
        return True
    if len(tail) > 8 or len(tail[0]) > 80 or len(tail[0].split()) > 6:
        return False
    if not re.fullmatch(r"[-\w .,’\'()/]+", tail[0]) or re.search(r"\b(?:if|unless|because|failed|blocked|confirmed|please|will|must|should|deployed|is|was|not|ready|approved)\b", tail[0], re.I):
        return False
    name = re.sub(r"\((?:she/her|he/him|they/them)\)", "", tail[0], flags=re.I)
    words = re.findall(r"[A-Za-z]+", name)
    if words and any(not word[0].isupper() and word not in {"de", "van", "von", "del"} for word in words):
        return False
    return all(len(part) <= 160 and (re.fullmatch(r"[-\w &.,’\'()/]+", part) or re.search(r"@|https?://|\b(?:phone|mobile|tel|team)\b", part, re.I)) for part in tail[1:])


def _clean_section(lines):
    lines = [re.sub(r"^[ \t]*>[ \t]?", "", line).strip() for line in lines]
    while lines and not lines[-1]:
        lines.pop()
    for index, line in enumerate(lines):
        if _DISCLAIMER.match(line) or re.match(r"^Sent from (?:my (?:iPhone|iPad|Android)|Outlook)|^Get Outlook for (?:iOS|Android)|^从我的(?:iPhone|iPad)发送", line, re.I):
            lines = lines[:index]
            break
        if _SIGNOFF.fullmatch(line):
            # A sign-off needs a short signature tail, not substantive prose.
            if _signature(lines[index + 1:]):
                lines = lines[:index]
                break
    lines = [line for line in lines if not _FOOTER.match(line)]
    text = "\n".join(lines).strip()
    return re.sub(r"\n{3,}", "\n\n", text)


def clean_text(text):
    """Remove envelopes conservatively; retain distinct quoted evidence verbatim."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\xa0", " ")
    text = re.sub(r"[\u200b\ufeff]", "", text)
    lines = text.split("\n")
    sections, current, quoted = [], [], False
    index = 0
    while index < len(lines):
        line = re.sub(r"^[ \t]*>[ \t]?", "", lines[index]).strip()
        header = _HEADER.match(line)
        if header and _FROM.fullmatch(header[1]):
            end, kinds = index, set()
            # Outlook envelopes may have blank lines and wrapped recipient values.
            for pos in range(index, min(index + 35, len(lines))):
                candidate = _HEADER.match(re.sub(r"^[ \t]*>[ \t]?", "", lines[pos]).strip())
                if candidate:
                    kinds.add(candidate[1].casefold())
                    if _SUBJECT.fullmatch(candidate[1]):
                        end = pos + 1
                        break
                elif lines[pos].strip() and pos > index and not re.search(r"@|[<>]", lines[pos]):
                    break
            if end > index and len(kinds) >= 3:
                sections.append((_clean_section(current), quoted))
                current, quoted, index = [], True, end
                continue
        if re.match(r"^On .{1,300} wrote:$|^在.{1,300}写道[：:]$|^-{2,}\s*(?:Original Message|Forwarded message|原始邮件)\s*-{2,}$", line, re.I):
            sections.append((_clean_section(current), quoted))
            current, quoted = [], True
        else:
            current.append(lines[index])
        index += 1
    sections.append((_clean_section(current), quoted))
    kept, seen, has_quotes = [], set(), False
    for body, is_quote in sections:
        if not body or _COURTESY.fullmatch(body):
            continue
        key = re.sub(r"\s+", " ", body)
        if key in seen:
            continue
        seen.add(key)
        if is_quote:
            has_quotes = True
            body = "[Earlier quoted message; author and date not verified]\n" + body
        kept.append(body)
    return "\n\n".join(kept), has_quotes


def _source_metadata(raw, quoted=False):
    sender = (raw.get("from") or {}).get("emailAddress") or {}
    link = raw.get("webLink", "")
    try:
        url = urlsplit(link) if isinstance(link, str) else urlsplit("")
        safe_link = link if url.scheme == "https" and url.netloc in {"outlook.office.com", "outlook.office365.com", "outlook.live.com"} else ""
    except ValueError:
        safe_link = ""
    return {"subject": raw.get("subject", ""), "sender": sender.get("address", ""), "sender_name": sender.get("name", ""), "received_at": raw["receivedDateTime"], "sent_at": raw.get("sentDateTime", ""), "thread_id": raw.get("conversationId", ""), "folder_id": raw["parentFolderId"], "source_url": safe_link, "has_quoted_content": quoted}


def _failed_message(metadata, mailbox_id, error):
    return {"source_key": source_key(metadata, mailbox_id), "source_version": source_version(metadata), "content": "", "metadata": _source_metadata(metadata), "skip_reason": None, "source_text": "", "raw": {key: value for key, value in metadata.items() if key not in {"body", "bodyPreview"}}, "error": error}


def normalize_message(raw, mailbox_id):
    _metadata(raw)
    body = raw.get("body")
    if not isinstance(body, dict) or not isinstance(body.get("content"), str) or str(body.get("contentType", "")).casefold() not in {"text", "html"}:
        raise WorkIQError("workiq_complete_body_missing")
    if len(body["content"].encode()) > MAX_BODY_BYTES:
        raise WorkIQError("workiq_body_too_large")
    source_text = html_to_text(body["content"]) if body["contentType"].casefold() == "html" else body["content"]
    content, quoted = clean_text(source_text)
    reason = "draft" if raw["isDraft"] else "empty_or_courtesy" if not content else None
    # A short review request that merely repeats the PR title contains no finding.
    # Comments explaining a defect, condition or decision must remain eligible.
    if (not quoted and len(content) < 700 and
            re.search(r'please review (?:the following|this) (?:PR|pull request)', content, re.I) and
            re.search(r'(?:feedback and approval|when you have a chance)', content, re.I) and
            not re.search(r'\b(?:because|if|unless|regression|fails?|bug|breaks?|tested|confirmed|decision|must|blocked)\b', content, re.I)):
        reason = 'review_request_only'
    # A bare meeting transport block has no meeting notes or work evidence.
    if re.search(r"Microsoft Teams (?:meeting|会议)", content):
        remainder = [line for line in content.splitlines() if not _TEAMS.match(line)]
        content = re.sub(r"\n{3,}", "\n\n", "\n".join(remainder)).strip()
        if not content:
            reason = "meeting_join_details"
    # Require the complete machine-template fingerprint; human incident replies
    # and technical comments in automated notifications remain eligible.
    monitor_data = all(marker in content for marker in ("Monitor.MetricData", "Monitor.ThresholdViolated")) or all(marker in content for marker in ("Created by LocalActiveMonitoring", "Recent responder results:", "ResultId"))
    if content.startswith("Incident Notification:") and all(marker in content for marker in ("Incident Details", "Create override rules:")) and monitor_data and not quoted:
        reason = "routine_monitor_notification"
    if "has sent you a protected message" in source_text and "Microsoft Purview Message Encryption" in source_text:
        raise WorkIQError("workiq_protected_body_unavailable")
    metadata = _source_metadata(raw, quoted)
    if len(content.encode()) > MAX_TEXT_BYTES:
        raise WorkIQError("workiq_body_too_large")
    return {"source_key": source_key(raw, mailbox_id), "source_version": source_version(raw), "content": "" if reason else content, "metadata": metadata, "skip_reason": reason, "source_text": source_text.strip(), "raw": raw}
