import asyncio
from contextlib import asynccontextmanager
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from provenloop.mail_source import (
    METADATA_FIELDS, WorkIQError, WorkIQMailSource, _unpack, clean_text,
    html_to_text, normalize_message, recommended_folders, source_key,
    source_version, validate_next_link,
)


def mail(**changes):
    value = {
        "id": "message", "internetMessageId": "<message@example.com>",
        "parentFolderId": "inbox-id", "conversationId": "thread",
        "receivedDateTime": "2026-09-15T01:00:00Z",
        "lastModifiedDateTime": "2026-09-15T01:00:00Z",
        "subject": "Migration", "isDraft": False,
        "from": {"emailAddress": {"address": "owner@example.com", "name": "Owner"}},
        "body": {"contentType": "text", "content": "Do not remove v1 until the host upgrade is confirmed."},
        "webLink": "https://outlook.office.com/mail/id/message",
    }
    value.update(changes)
    return value


class CleaningTests(unittest.TestCase):
    def test_html_removes_hidden_and_executable_but_keeps_content(self):
        content = html_to_text("<head>hidden title</head><p>A &amp; B</p><div style='display: none'>tracking</div><script>bad()</script><p>Do not migrate unless ready.</p><img src='https://tracker.test'>")
        self.assertIn("A & B", content)
        self.assertIn("Do not migrate unless ready.", content)
        for junk in ("hidden", "tracking", "bad", "tracker"):
            self.assertNotIn(junk, content)

    def test_envelopes_signatures_and_duplicate_quotes(self):
        quote = "From: Earlier <earlier@example.com>\nSent: Monday\nTo: Owner <owner@example.com>\nSubject: Migration\n\nKeep v1 until the owner confirms v2.\n\nThanks,\nEarlier"
        value = normalize_message(mail(body={"contentType": "text", "content": "Host v2 is not deployed.\n\nRegards,\nOwner\n\n" + quote + "\n\n" + quote}), "mailbox")
        self.assertEqual(value["content"].count("Keep v1 until"), 1)
        self.assertIn("Host v2 is not deployed.", value["content"])
        for junk in ("From:", "To:", "Subject:", "Regards", "Thanks"):
            self.assertNotIn(junk, value["content"])
        self.assertTrue(value["metadata"]["has_quoted_content"])

    def test_chinese_headers_and_short_findings(self):
        content, quoted = clean_text("失败了。只有确认配置之后才能重试。\n\n发件人：A <a@example.com>\n发送时间：周一\n收件人：B <b@example.com>\n主题：配置\n\n不要删除旧版本。")
        self.assertIn("失败了。只有确认配置之后才能重试。", content)
        self.assertIn("不要删除旧版本。", content)
        self.assertNotIn("发件人", content)
        self.assertTrue(quoted)

    def test_prose_looking_like_header_or_signoff_is_preserved(self):
        text = "From: the old runtime we learned the migration is blocked.\nDo not remove it.\nThanks\nIf the rollout fails, retain v1."
        self.assertEqual(clean_text(text)[0], text)
        text = "Thanks\nThe rollout succeeded."
        self.assertEqual(clean_text(text)[0], text)

    def test_courtesy_skipped_but_short_result_kept(self):
        self.assertEqual(normalize_message(mail(body={"contentType": "text", "content": "Thanks!\n\nRegards,\nOwner"}), "mailbox")["skip_reason"], "empty_or_courtesy")
        for result in ("It failed.", "Approved.", "Not approved.", "Still blocked.", "可以，但需要先验证。"):
            self.assertEqual(normalize_message(mail(body={"contentType": "text", "content": result}), "mailbox")["content"], result)

    def test_complete_body_and_identity_required(self):
        for changes in ({"body": None, "bodyPreview": "pretend full body"}, {"internetMessageId": ""}, {"lastModifiedDateTime": None}):
            with self.assertRaises(WorkIQError):
                normalize_message(mail(**changes), "mailbox")

    def test_stable_key_moves_and_metadata_version(self):
        first = mail()
        moved = mail(id="moved", parentFolderId="other")
        self.assertEqual(source_key(first, "mailbox"), source_key(moved, "mailbox"))
        self.assertNotEqual(source_key(first, "mailbox"), source_key(first, "another"))
        self.assertEqual(normalize_message(first, "mailbox")["source_version"], source_version(first))
        self.assertNotEqual(source_version(first), source_version(mail(lastModifiedDateTime="2026-09-15T02:00:00Z")))

    def test_source_link_allowlist(self):
        for url in ("javascript:alert(1)", "https://outlook.office.com@evil.test/mail", "https://evil.test"):
            self.assertEqual(normalize_message(mail(webLink=url), "mailbox")["metadata"]["source_url"], "")

    def test_meeting_transport_only_skipped_and_notes_preserved(self):
        join = "Microsoft Teams meeting\nJoin: https://teams.test/join\nMeeting ID: 123\nPasscode: abc\nNeed help? | System reference\nFor organizers: Meeting options"
        self.assertEqual(normalize_message(mail(body={"contentType": "text", "content": join}), "mailbox")["skip_reason"], "meeting_join_details")
        self.assertIsNone(normalize_message(mail(body={"contentType": "text", "content": "Decision: retain v1 until Friday.\n" + join}), "mailbox")["skip_reason"])
        chinese = "议程：介绍产品。\n__________\nMicrosoft Teams 会议\n加入: https://teams.test/join\n会议 ID: 123\n密码: abc\n是否需要帮助?\n对于组织者: 会议选项\n__________"
        self.assertEqual(normalize_message(mail(body={"contentType": "text", "content": chinese}), "mailbox")["content"], "议程：介绍产品。")

    def test_notification_comment_kept_footer_removed(self):
        text = "Blocking regression: legacy clients cannot use v2.\n\nView comment  Open in CodeFlow\nWe sent you this notification due to a default subscription.\nMicrosoft respects your privacy.\nSent from Azure DevOps"
        self.assertEqual(clean_text(text)[0], "Blocking regression: legacy clients cannot use v2.")
        self.assertEqual(clean_text("Failure confirmed.\nBest regards,\nA. Reader,\nSoftware Engineer II,\nExample Team.")[0], "Failure confirmed.")

    def test_routine_monitor_skipped_but_reply_not_skipped(self):
        text = "Incident Notification: Monitor unhealthy\nIncident Details\nMonitor.MetricData 1,2,3\nMonitor.ThresholdViolated True\nCreate override rules: suppression"
        self.assertEqual(normalize_message(mail(body={"contentType": "text", "content": text}), "mailbox")["skip_reason"], "routine_monitor_notification")
        self.assertIsNone(normalize_message(mail(body={"contentType": "text", "content": "Root cause is deployment.\n" + text}), "mailbox")["skip_reason"])
        text = "Incident Notification: service crashing\nIncident Details\nCreate override rules:\nCreated by LocalActiveMonitoring\nRecent responder results:\nResultId 123"
        self.assertEqual(normalize_message(mail(body={"contentType": "text", "content": text}), "mailbox")["skip_reason"], "routine_monitor_notification")


class ProtocolTests(unittest.TestCase):
    def test_structured_and_text_results(self):
        payload = {"results": [{"statusCode": 200, "data": {"id": "a"}}]}
        for root in ({"structuredContent": payload}, {"structured_content": payload}, {"content": [{"type": "text", "text": json.dumps(payload)}]}):
            self.assertEqual(_unpack(root, 1), [{"id": "a"}])
        for root in ({"isError": True}, {"structuredContent": {"results": [{"statusCode": 403, "data": {}}]}}, {"structuredContent": payload}):
            with self.assertRaises(WorkIQError):
                _unpack(root, 2)
        missing = {"structuredContent": {"results": [{"statusCode": 404, "data": {}}, {"statusCode": 200, "data": {"id": "a"}}]}}
        self.assertEqual(_unpack(missing, 2, allow_missing=True)[1], {"id": "a"})
        with self.assertRaises(WorkIQError):
            _unpack(missing, 2)

    def test_next_link_scope_and_opaque_token(self):
        scope = "receivedDateTime ge 2026-09-01T00:00:00Z and receivedDateTime lt 2026-09-16T00:00:00Z"
        query = urlencode({"$filter": scope, "$select": METADATA_FIELDS, "$top": 25, "$skiptoken": "A+B/=="})
        path = "/me/mailFolders/inbox-id/messages"
        link = "https://graph.microsoft.com/v1.0/me/mailFolders('inbox-id')/messages?" + query
        self.assertEqual(validate_next_link(link, path, METADATA_FIELDS, scope, 25), path + "?" + query)
        for invalid in (link.replace("graph.microsoft.com", "evil.test"), link.replace("inbox-id", "other"), link + "&$expand=body", link + "&$select=id", link.replace("2026-09-01", "2025-09-01"), link.replace("$", "%24") + "#fragment"):
            with self.assertRaises(WorkIQError):
                validate_next_link(invalid, path, METADATA_FIELDS, scope, 25)

    def test_recommended_subtrees_and_unresolved(self):
        folders = [{"id": "in", "name": "Inbox", "parent_id": "root"}, {"id": "ds", "name": "DSAPI SOT", "parent_id": "in"}, {"id": "sev", "name": "Sev3", "parent_id": "ds"}, {"id": "sevsub", "name": "Useful", "parent_id": "sev"}, {"id": "pr", "name": "PullRequests", "parent_id": "ds"}, {"id": "keep", "name": "Deployment", "parent_id": "ds"}]
        self.assertEqual(recommended_folders(folders), [])
        self.assertEqual({x["id"] for x in folders if x["selected"]}, {"in", "ds", "keep"})
        self.assertEqual({x["id"] for x in folders if x["excluded"]}, {"sev", "sevsub", "pr"})
        self.assertEqual(recommended_folders([]), ["Inbox", "DSAPISOT"])


class AsyncProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_session_lifetime_owned_by_one_task(self):
        owner, callers, commands = [], [], []
        @asynccontextmanager
        async def transport(*args, **kwargs):
            owner.append(asyncio.current_task())
            commands.append(args[0].args)
            yield None, None
            self.assertIs(asyncio.current_task(), owner[0])
        class Session:
            def __init__(self, *args):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                self_test.assertIs(asyncio.current_task(), owner[0])
            async def initialize(self):
                pass
            async def list_tools(self):
                return SimpleNamespace(tools=[SimpleNamespace(name="fetch", input_schema={"properties": {"entityUrls": {"type": "array", "items": {"type": "string"}}}, "required": ["entityUrls"]})])
            async def call_tool(self, name, arguments, **kwargs):
                callers.append(asyncio.current_task())
                return {"structuredContent": {"results": [{"statusCode": 200, "data": {"id": "account", "mail": "a@example.com", "userPrincipalName": "a@example.com"}}]}}
        self_test = self
        with patch("provenloop.mail_source.find_workiq", return_value="workiq.exe"), patch("mcp.client.stdio.stdio_client", transport), patch("mcp.ClientSession", Session):
            source = WorkIQMailSource()
            await asyncio.create_task(source.__aenter__())
            await asyncio.create_task(source.account())
            await asyncio.create_task(source.close())
        self.assertEqual(len(owner), 3)
        self.assertNotIn("--account", commands[0])
        self.assertEqual(commands[1][-2:], ["--account", "a@example.com"])
        self.assertNotIn("--account", commands[2])
        self.assertTrue(all(task is owner[0] for task in callers))

    async def test_account_change_rejected(self):
        source = WorkIQMailSource()
        values = [{"id": "account", "mail": "a@example.com", "userPrincipalName": "a@example.com"}, {"id": "other", "mail": "b@example.com", "userPrincipalName": "b@example.com"}]
        class Session:
            async def call_tool(self, *args, **kwargs):
                return {"structuredContent": {"results": [{"statusCode": 200, "data": values.pop(0)}]}}
        session = Session()
        source._account = await source._read_account(session)
        with self.assertRaisesRegex(WorkIQError, "account_changed"):
            await source._read_account(session)

    async def test_page_rejects_wrong_folder_and_window(self):
        source = WorkIQMailSource()
        async def account():
            return {}
        source.account = account
        for item in (mail(parentFolderId="other"), mail(receivedDateTime="2026-08-01T00:00:00Z")):
            async def fetch(paths):
                return [{"value": [item]}]
            source._fetch = fetch
            with self.assertRaisesRegex(WorkIQError, "outside_scope"):
                await source.page("inbox-id", "2026-09-01T00:00:00Z", "2026-09-16T00:00:00Z")

    async def test_batched_body_fetch_checks_each_identity(self):
        source = WorkIQMailSource(concurrency=2)
        source._account = {"id": "mailbox"}
        async def account():
            return source._account
        source.account = account
        calls = []
        async def fetch(paths, **kwargs):
            calls.append(paths)
            return [mail() for _ in paths]
        source._fetch = fetch
        self.assertEqual(len(await source.messages([mail(), mail(), mail()])), 3)
        self.assertEqual([len(x) for x in calls], [2, 1])
        async def wrong(paths, **kwargs):
            return [mail(id="wrong")]
        source._fetch = wrong
        with self.assertRaisesRegex(WorkIQError, "message_changed"):
            await source.messages([mail()])

    async def test_permanent_body_failure_does_not_drop_other_mail(self):
        source = WorkIQMailSource(concurrency=3)
        source._account = {"id": "mailbox"}
        async def account():
            return source._account
        source.account = account
        async def fetch(paths, **kwargs):
            return [mail(body=None), {"_workiq_error": "workiq_message_unavailable"}, mail()]
        source._fetch = fetch
        output = await source.messages([mail(), mail(), mail()])
        self.assertEqual(output[0]["error"], "workiq_complete_body_missing")
        self.assertEqual(output[1]["error"], "workiq_message_unavailable")
        self.assertNotIn("body", output[0]["raw"])
        self.assertIn("Do not remove", output[2]["content"])


if __name__ == "__main__":
    unittest.main()
