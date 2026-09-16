import asyncio
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timezone

from provenloop.mail_sync import MailSync, quote_segments, extraction_content, QUOTE_MARKER, KNOWN_QUOTE
import json
from provenloop.mail_source import WorkIQError, source_key, source_version


class Missing(Exception):
    status = 404


class Source:
    def __init__(self):
        self.identity = {"id": "account-a", "mail": "a@example.invalid", "displayName": "Account A"}
        self.folders = [{"id": "inbox", "name": "Inbox", "path": "Inbox", "parent_id": None, "recommended": True},
                        {"id": "excluded", "name": "Sev3", "path": "DSAPISOT/Sev3", "parent_id": "ds", "excluded": True}]
        self.pages = {None: ([self.mail("one"), self.mail("noise")], "page-2"), "page-2": ([self.mail("two")], None)}
        self.reads, self.bodies = [], []
        self.body_gate = None
        self.fail_page = None
        self.errors = set()
        self.semantic = {}
        self.noise = {"noise"}
        self.account_error = False

    @staticmethod
    def mail(name, version="2026-09-16T04:00:00Z"):
        return {"id": name, "internetMessageId": "<" + name + "@example.invalid>", "parentFolderId": "inbox",
                "lastModifiedDateTime": version, "receivedDateTime": "2026-09-16T03:00:00Z", "subject": name}

    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def account(self):
        if self.account_error: raise WorkIQError("workiq_account_changed")
        return self.identity
    async def discover(self): return {"account": await self.account(), "folders": self.folders, "unresolved": ["DSAPISOT"]}
    async def page(self, folder, start, end, next_link=None):
        self.reads.append((folder, start, end, next_link))
        if next_link == self.fail_page and self.fail_page is not None:
            raise ConnectionError("private content must not appear in public status")
        messages, next_page = self.pages[next_link]
        return {"messages": deepcopy(messages), "next_link": next_page}

    async def messages(self, metadata):
        self.bodies.extend(m["id"] for m in metadata)
        if self.body_gate:
            await self.body_gate.wait()
        return [{"source_key": source_key(m, self.identity["id"]), "source_version": source_version(m),
                 "content": "Validated finding for " + m["id"], "source_text": "Original evidence " + m["id"],
                 "metadata": {"subject": m["subject"], "sender": "author@example.invalid", "received_at": m["receivedDateTime"], **self.semantic},
                 "error": "body_unavailable" if m["id"] in self.errors else None,
                 "skip_reason": "Courtesy" if m["id"] in self.noise else None, "raw": m} for m in metadata]


class Client:
    def __init__(self):
        self.operations = self.documents = self
        self.jobs, self.docs = {}, {}
        self.submissions, self.deleted = [], []
        self.empty = False
        self.status_value = "completed"
        self.errors = 0
        self.accept_then_fail = False
        self.config = None
        self.retries = []
        self.reprocessed = []
        self.reprocess_loss = False
        self.listed = []

    async def acreate_bank(self, **kwargs): pass
    async def aupdate_bank_config(self, **kwargs): self.config = kwargs
    async def aclose(self): pass
    async def aretain_batch(self, **kwargs):
        self.submissions.append(kwargs)
        operation = kwargs["operation_id"]
        self.jobs[operation] = {"status": self.status_value, "result_metadata": {"extraction_errors_count": self.errors}}
        for item in kwargs["items"]:
            self.docs[item["document_id"]] = {"memory_unit_count": 0 if self.empty else 1}
        if self.accept_then_fail:
            self.accept_then_fail = False
            raise ConnectionError("Response lost after acceptance")
        return {"operation_id": operation}

    async def get_operation_status(self, bank_id, operation_id):
        if operation_id not in self.jobs: raise Missing()
        return deepcopy(self.jobs[operation_id])

    async def retry_operation(self, bank_id, operation_id):
        self.retries.append(operation_id)
        self.jobs[operation_id]["status"] = "completed"
        return {"operation_id": operation_id}

    async def get_document(self, bank_id, document_id):
        if document_id not in self.docs: raise Missing()
        return self.docs[document_id]

    async def delete_document(self, bank_id, document_id):
        self.deleted.append(document_id)
        if document_id not in self.docs: raise Missing()
        del self.docs[document_id]

    async def reprocess_document(self, bank_id, document_id):
        self.reprocessed.append(document_id)
        operation = "reprocess-" + str(len(self.reprocessed))
        self.jobs[operation] = {"status": "completed", "result_metadata": {"extraction_errors_count": 0}}
        self.listed.insert(0, {"id": operation, "document_id": document_id, "created_at": datetime.now(timezone.utc).isoformat()})
        if self.reprocess_loss:
            self.reprocess_loss = False
            raise ConnectionError("Lost reprocess response")
        return {"operation_id": operation}

    async def list_operations(self, **kwargs):
        return {"operations": self.listed}


class MailSyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.source, self.client = Source(), Client()
        self.sync = self.runner()
        await self.sync.discover()
        await self.sync.configure({"interval_minutes": 0})

    def runner(self):
        runner = MailSync(Path(self.temp.name), "http://127.0.0.1:9077", source=self.source, client=self.client)
        runner.poll_seconds = 0.001
        return runner

    async def asyncTearDown(self):
        await self.sync.close()
        self.temp.cleanup()

    async def finish(self):
        await self.sync.sync()
        await asyncio.wait_for(self.sync._task, 3)
        return self.sync.status()

    async def test_preview_and_default_scope_do_not_retain(self):
        result = await self.sync.preview()
        self.assertEqual(result["config"]["folder_ids"], ["inbox"])
        self.assertEqual(result["account"]["address"], "a@example.invalid")
        self.assertEqual(result["warnings"], ["DSAPISOT"])
        self.assertEqual(result["items"][0]["source"], "Original evidence one")
        self.assertFalse(self.client.submissions)
        self.assertEqual(self.sync.db.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)
        with self.assertRaises(ValueError):
            await self.sync.configure({"folder_ids": ["excluded"]})

    async def test_pagination_fixed_window_and_unchanged_metadata_skip_bodies(self):
        result = await self.finish()
        self.assertEqual(result["run"]["state"], "idle")
        self.assertEqual(result["run"]["imported"], 2)
        self.assertEqual(result["run"]["skipped"], 1)
        first, second = self.source.reads
        self.assertEqual(first[1:3], second[1:3])
        self.assertEqual(second[3], "page-2")
        self.assertEqual(self.client.config["retain_extraction_mode"], "custom")
        count = len(self.source.bodies)
        await self.finish()
        self.assertEqual(len(self.source.bodies), count)
        self.assertEqual(len(self.client.submissions), 2)
        self.assertEqual(self.sync.status()["run"]["pending"], 0)
        self.assertFalse(self.sync.db.execute("SELECT 1 FROM messages WHERE payload IS NOT NULL").fetchone())

    async def test_modified_metadata_with_identical_clean_text_avoids_model(self):
        await self.finish()
        self.source.pages[None][0][0]["lastModifiedDateTime"] = "2026-09-17T04:00:00Z"
        await self.finish()
        self.assertEqual(len(self.client.submissions), 2)
        self.assertEqual(self.source.bodies.count("one"), 2)

    def test_known_quotes_stay_as_context_without_losing_new_confirmation(self):
        earlier = 'The legacy client accepts an array through value only.'
        _, hashes = quote_segments(earlier)
        content = 'Confirmed in production; keep the compatibility path.\n\n' + QUOTE_MARKER + '\n' + earlier
        prepared, _ = quote_segments(content, hashes)
        self.assertIn(KNOWN_QUOTE, prepared)
        self.assertIn('Confirmed in production', prepared)
        self.assertIn(earlier, prepared)
        unseen, _ = quote_segments(content)
        self.assertIn(QUOTE_MARKER, unseen)
        self.assertNotIn(KNOWN_QUOTE, unseen)
        structured, _ = extraction_content(content, {'sender_name':'Current author', 'sent_at':'2026-09-16T00:00:00Z'}, hashes)
        turns = [json.loads(line) for line in structured.splitlines()]
        self.assertEqual(turns[0]['author'], 'Current author')
        self.assertIsNone(turns[1]['author'])
        self.assertIsNone(turns[1]['reported_at'])
        self.assertTrue(turns[1]['previously_imported'])
        self.assertEqual(turns[1]['text'], earlier)

    async def test_response_loss_recovers_same_operation_without_duplicate_submit(self):
        self.client.accept_then_fail = True
        result = await self.finish()
        self.assertEqual(result["run"]["state"], "error")
        self.assertEqual(result["run"]["pending"], 1)
        operation = self.client.submissions[0]["operation_id"]
        await self.sync.close()
        self.sync = self.runner()
        result = await self.finish()
        self.assertEqual(result["run"]["state"], "idle")
        self.assertEqual([s["operation_id"] for s in self.client.submissions].count(operation), 1)
        self.assertEqual(self.source.bodies.count("one"), 1)

    async def test_page_failure_restarts_same_checkpoint_and_redacts_error(self):
        self.source.fail_page = "page-2"
        result = await self.finish()
        self.assertEqual(result["run"]["state"], "error")
        self.assertNotIn("private", result["run"]["error"])
        before = self.source.reads[-1]
        self.source.fail_page = None
        await self.sync.close()
        self.sync = self.runner()
        result = await self.finish()
        self.assertEqual(self.source.reads[-1], before)
        self.assertEqual(result["run"]["state"], "idle")

    async def test_account_change_pauses_without_reading_or_submission(self):
        self.source.identity = {"id": "account-b", "mail": "b@example.invalid"}
        await self.sync.start()
        await self.sync._task
        result = self.sync.status()
        self.assertEqual(result["run"]["state"], "paused")
        self.assertFalse(result["config"]["enabled"])
        self.assertFalse(self.source.reads)
        self.assertFalse(self.client.submissions)

    async def test_source_identity_error_pauses_connection(self):
        self.source.account_error = True
        await self.sync.start()
        await self.sync._task
        self.assertFalse(self.sync.status()["config"]["enabled"])
        self.assertEqual(self.sync.status()["run"]["state"], "paused")

    async def test_selected_folder_newly_excluded_pauses_before_read(self):
        self.source.folders[0]["excluded"] = True
        await self.sync.start()
        await self.sync._task
        self.assertEqual(self.sync.status()["run"]["state"], "paused")
        self.assertFalse(self.source.reads)

    async def test_pause_cancels_reads_and_keeps_submitted_payload_for_resume(self):
        self.client.status_value = "processing"
        await self.sync.start()
        for _ in range(100):
            if self.client.submissions: break
            await asyncio.sleep(0.001)
        self.assertEqual(self.sync.status()["run"]["pending"], 1)
        await self.sync.pause()
        self.assertEqual(len(self.source.reads), 1)
        for result in self.client.jobs.values(): result["status"] = "completed"
        self.client.status_value = "completed"
        await self.finish()
        self.assertEqual(len(self.client.submissions), 2)

    async def test_zero_facts_document_removed_and_rejected_body_erased(self):
        self.client.empty = True
        result = await self.finish()
        self.assertEqual(result["run"]["imported"], 0)
        self.assertEqual(result["run"]["skipped"], 3)
        self.assertEqual(len(self.client.deleted), 2)
        self.assertFalse(self.client.docs)
        self.assertEqual(result["run"]["pending"], 0)

    async def test_extraction_errors_and_model_failures_do_not_count_as_imported(self):
        self.client.errors = 1
        result = await self.finish()
        self.assertEqual(result["run"]["state"], "error")
        self.assertEqual(result["run"]["imported"], 0)
        self.assertEqual(result["run"]["pending"], 1)
        self.assertIsNone(result["run"]["last_success"])
        self.client.errors = 0
        result = await self.finish()
        self.assertEqual(result["run"]["state"], "idle")
        self.assertEqual(len(self.client.reprocessed), 1)
        self.assertFalse(self.client.deleted)

    async def test_failed_official_operation_uses_retry_endpoint(self):
        self.client.status_value = "failed"
        await self.finish()
        self.client.status_value = "completed"
        result = await self.finish()
        self.assertEqual(result["run"]["state"], "idle")
        self.assertEqual(len(self.client.retries), 1)

    async def test_cancelled_official_operation_retries_with_new_id_same_document(self):
        self.client.status_value = "cancelled"
        result = await self.finish()
        self.assertEqual(result["run"]["state"], "error")
        original = self.client.submissions[0]
        self.client.status_value = "completed"
        result = await self.finish()
        replacement = self.client.submissions[1]
        self.assertNotEqual(original["operation_id"], replacement["operation_id"])
        self.assertEqual(original["items"][0]["document_id"], replacement["items"][0]["document_id"])
        self.assertEqual(result["run"]["state"], "idle")
        self.assertEqual(result["run"]["pending"], 0)
        self.assertFalse(self.client.retries)

    async def test_reprocess_response_loss_recovers_official_operation(self):
        self.client.errors = 1
        await self.finish()
        self.client.errors = 0
        self.client.reprocess_loss = True
        await self.finish()
        self.assertEqual(self.sync.status()["run"]["state"], "error")
        await self.sync.close()
        self.sync = self.runner()
        await self.finish()
        self.assertEqual(self.sync.status()["run"]["state"], "idle")
        self.assertEqual(len(self.client.reprocessed), 1)

    async def test_boot_resumes_enabled_manual_connection_once(self):
        config = self.sync.status()["config"]
        config["enabled"] = True
        await self.sync.configure(config)
        await self.sync.close()
        self.sync = self.runner()
        await self.sync.boot()
        await self.sync._task
        self.assertEqual(self.sync.status()["run"]["state"], "idle")
        self.assertIsNone(self.sync.status()["run"]["next_run"])

    async def test_invalid_and_unchanged_config_leave_active_run_untouched(self):
        self.source.body_gate = asyncio.Event()
        await self.sync.start()
        for _ in range(100):
            if self.source.bodies: break
            await asyncio.sleep(0.001)
        task = self.sync._task
        await self.sync.configure(self.sync.status()["config"])
        with self.assertRaises(ValueError): await self.sync.configure({"lookback_days": -1})
        self.assertFalse(task.done())
        await self.sync.pause()

    async def test_expanding_lookback_backfills_without_reimporting_known_messages(self):
        await self.finish()
        original = self.sync._get("history_start")
        await self.sync.configure({"lookback_days": 90})
        self.assertLess(self.sync._get("history_start"), original)
        self.assertEqual(self.sync._get("watermarks"), {})
        await self.finish()
        self.assertEqual(len(self.client.submissions), 2)

    async def test_semantic_metadata_change_replaces_doc_and_uses_sent_date(self):
        await self.finish()
        original = self.client.submissions[0]["items"][0]["document_id"]
        self.source.pages[None][0][0]["lastModifiedDateTime"] = "2026-09-17T04:00:00Z"
        self.source.semantic = {"sender": "correct-author@example.invalid", "sent_at": "2026-09-15T03:00:00Z"}
        await self.finish()
        item = self.client.submissions[-1]["items"][0]
        self.assertEqual(item["document_id"], original)
        self.assertEqual(item["update_mode"], "replace")
        self.assertEqual(item['timestamp'], 'unset')
        self.assertIn('2026-09-15', json.loads(item['content'].splitlines()[0])['reported_at'])

    async def test_changed_source_now_noise_removes_previous_facts(self):
        await self.finish()
        original = self.client.submissions[0]["items"][0]["document_id"]
        self.source.pages[None][0][0]["lastModifiedDateTime"] = "2026-09-17T04:00:00Z"
        self.source.noise.add("one")
        # Real cleaner returns empty text for rejected sources.
        original_messages = self.source.messages
        async def messages(metadata):
            result = await original_messages(metadata)
            for item in result:
                if item["skip_reason"]: item["content"] = ""
            return result
        self.source.messages = messages
        await self.finish()
        self.assertIn(original, self.client.deleted)
        self.assertNotIn(original, self.client.docs)

    async def test_bad_body_has_retry_receipt_and_does_not_block_following_page(self):
        self.source.errors.add("one")
        result = await self.finish()
        self.assertEqual(result["run"]["state"], "error")
        self.assertEqual(result["run"]["imported"], 1)
        self.assertEqual(result["run"]["failed"], 1)
        self.assertEqual(self.source.reads[-1][3], "page-2")
        receipt = self.sync.db.execute("SELECT metadata FROM receipts").fetchone()[0]
        self.assertNotIn("body", receipt)
        self.source.errors.clear()
        result = await self.finish()
        self.assertEqual(result["run"]["state"], "idle")
        self.assertFalse(self.sync.db.execute("SELECT 1 FROM receipts").fetchone())

    async def test_retry_receipts_respect_changed_folder_scope(self):
        self.source.folders.append({"id": "other", "name": "Other", "path": "Other", "parent_id": None})
        self.source.errors.add("one")
        await self.finish()
        self.assertEqual(self.sync.db.execute("SELECT COUNT(*) FROM receipts").fetchone()[0], 1)
        await self.sync.discover()
        await self.sync.configure({"folder_ids": ["other"]})
        self.source.pages = {None: ([], None)}
        self.source.errors.clear()
        self.source.bodies.clear()
        self.source.reads.clear()
        result = await self.finish()
        self.assertFalse(self.source.bodies)
        self.assertEqual([page[0] for page in self.source.reads], ["other"])
        self.assertEqual(result["run"]["state"], "idle")
        self.assertEqual(result["run"]["failed"], 0)
        self.assertEqual(self.sync.db.execute("SELECT COUNT(*) FROM receipts").fetchone()[0], 1)
        await self.sync.configure({"folder_ids": ["inbox"]})
        await self.finish()
        self.assertEqual(self.source.bodies, ["one"])
        self.assertFalse(self.sync.db.execute("SELECT 1 FROM receipts").fetchone())


if __name__ == "__main__":
    unittest.main()
