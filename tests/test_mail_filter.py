import copy
import unittest
from unittest.mock import patch

from hindsightkit.mail_filter import routine_thread_reason


def message(subject, content):
    return {'source_key': 'mail-one', 'content': content, 'metadata': {
        'subject': subject, 'thread_id': 'thread-one', 'has_quoted_content': False}}


def pim():
    return message('PIM: sampleuser activated the Key Vault Administrator role assignment', '''Example Tenant (ID: 00000000-0000-0000-0000-000000000001)
sampleuser activated the Key Vault Administrator role for the Example-Dev subscription
View the activation history for this user in the Privileged Identity Management (PIM) portal.
View history >
Settings\tValue
User or Group\tsampleuser
Role\tKey Vault Administrator
Resource\tExample-Dev
Resource type\tsubscription
Activated by\tsampleuser
Start\tSeptember 11, 2026 1:54 UTC
End\tSeptember 11, 2026 9:54 UTC
Justification\tdev
Privileged Identity Management protects your organization from accidental or malicious activity by reducing persistent access to Azure resources, providing just-in-time or time-limited access when needed.
Privacy Statement
Microsoft Corporation, One Microsoft Way, Redmond, WA 98052
Facilitated by''')


def award():
    return message('Action Required: Please accept your Stock Award',
                   'This is a synthetic stock-award notice. Visit the rewards portal to read and accept the plan documents.')


def agenda():
    return message('Working with agents - Example Learning Day FY27 Q1', '''Topic
Working with agents
Speaker
Example Speaker
Category
AI
Language
English
Description
This session introduces practical approaches for delegating routine work to agents.
FY27 Q1 Example Learning Day Agenda: Learning Day''')


def invitation():
    return message('[M365Core FHL] Working with agents', '''Working with agents
Speakers:
Example Speaker & Another Speaker
In this session, Example Speaker will share what works, what breaks, and how to delegate recurring work.
Example will cover practical approaches for using agents in everyday tasks.
Another will then walk through a demonstration of agents completing recurring tasks.
👥 Who Should Attend:
Anyone interested in having their agent complete independent tasks.
Level:
Open to All.
No coding experience required;
some familiarity with Copilot or other AI assistants is helpful.
M365 Core FHL – a dedicated week for employees to gain knowledge and expand skills.
It’s your unique opportunity to FIX an existing product, HACK something new, and LEARN new skills.
Choose your FHL learning journey!
Sessions are optional, so join the ones that interest you and support your learning goals.
📺 Watch recorded sessions: click HERE
📅 View the full learning schedule: click HERE
🎤 Interested in leading a session? Sign up HERE
❓Questions? Contact Example Contact
+1 425-555-0100,,123456789# United States, Redmond
(800) 555-0100,,123456789# United States (Toll-free)
Find a local number''')


class RoutineThreadTests(unittest.TestCase):
    cases = ((pim, 'role_activation_template'), (award, 'award_acceptance_template'),
             (agenda, 'learning_agenda_template'), (invitation, 'learning_invitation_template'))

    def setUp(self):
        replacement = patch('hindsightkit.mail_filter._AWARD_BODY_SHA256',
                            'a994b15e04a5c17b703a3de7facd961e830a52de0542bd2eb0fb7a9da2c36e33')
        replacement.start()
        self.addCleanup(replacement.stop)

    def test_complete_templates_are_skipped_without_mutating_messages(self):
        for factory, reason in self.cases:
            with self.subTest(reason=reason):
                messages = [factory()]
                before = copy.deepcopy(messages)
                self.assertEqual(routine_thread_reason(messages), reason)
                self.assertEqual(messages, before)

    def test_replies_and_multi_message_threads_are_kept(self):
        for factory, _ in self.cases:
            for prefix in ('Re: ', 'FW: ', 'Fwd: ', ' 回复：'):
                item = factory()
                item['metadata']['subject'] = prefix + item['metadata']['subject']
                self.assertIsNone(routine_thread_reason([item]))
            self.assertIsNone(routine_thread_reason([factory(), factory()]))

    def test_quoted_or_uncertain_quote_metadata_is_kept(self):
        for factory, _ in self.cases:
            for value in (True, None, 'false', 0):
                item = factory()
                item['metadata']['has_quoted_content'] = value
                self.assertIsNone(routine_thread_reason([item]))
            for quote in ('[Earlier quoted message; author and date not verified]', '> Earlier message',
                          'From: Example Person', 'On Monday Example Person wrote:', '---- Forwarded message ----'):
                item = factory()
                item['source_text'] = item['content'] + '\n' + quote
                self.assertIsNone(routine_thread_reason([item]))

    def test_extra_notes_or_missing_body_sections_are_kept(self):
        for factory, _ in self.cases:
            for transform in (lambda text: text + '\nAdditional context about the tenant.',
                              lambda text: 'A comment from the owner.\n' + text,
                              lambda text: '\n'.join(text.splitlines()[:-1])):
                item = factory()
                item['content'] = transform(item['content'])
                self.assertIsNone(routine_thread_reason([item]))

    def test_pim_incident_justification_is_kept(self):
        for reason in ('incident 1234', 'investigating key access', 'dev; access remains blocked', 'routine task and an unknown note'):
            item = pim()
            item['content'] = item['content'].replace('Justification\tdev', 'Justification\t' + reason)
            self.assertIsNone(routine_thread_reason([item]))

    def test_learning_technical_findings_are_kept(self):
        for finding in ('We found the client retries requests twice.', 'The root cause was a stale lease.',
                        'Observed the old deployment returning empty responses.', 'The workaround is a restart.',
                        'We confirmed the resource is inaccessible.', 'The operation failed after a timeout.'):
            for factory in (agenda, invitation):
                item = factory()
                item['content'] = item['content'].replace('routine work to agents.', 'routine work to agents. ' + finding)
                if factory is invitation:
                    item['content'] = item['content'].replace('recurring work.', 'recurring work. ' + finding)
                self.assertIsNone(routine_thread_reason([item]))

    def test_invalid_or_incomplete_messages_are_kept(self):
        for invalid in (None, [], {}, [None], [pim(), {'error': 'missing'}]):
            self.assertIsNone(routine_thread_reason(invalid))
        for changes in ({'error': 'missing'}, {'skip_reason': 'draft'}, {'content': ''}, {'content': None},
                        {'metadata': None}, {'source_text': ''}):
            self.assertIsNone(routine_thread_reason([{**pim(), **changes}]))
        item = pim()
        del item['metadata']['thread_id']
        self.assertIsNone(routine_thread_reason([item]))


if __name__ == '__main__':
    unittest.main()
