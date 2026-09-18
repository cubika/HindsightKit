import json
import unittest
from hindsightkit.connectors.workiq.metadata import source_metadata, content_labels, tags_for

class MetadataTests(unittest.TestCase):
    def test_content_labels_must_exist_in_outcome(self):
        self.assertEqual(content_labels(['DSAPI','dsapi','Admin API'], 'DSAPI uses Admin API.'), ['Admin API','DSAPI'])
        for label in ['not-in-text','DSAPI: admin','person@example.invalid']:
            with self.assertRaises(ValueError): content_labels([label], 'DSAPI uses Admin API.')

    def test_terms_use_the_same_rules_across_types(self):
        content='DSAPI uses P2P fallback after DsApiWrongServerException; the queue-age limit bounds work.'
        values=['DsApiWrongServerException','P2P fallback','queue-age limit','DSAPI','dsapi']
        self.assertEqual(content_labels(values,content), ['DSAPI','DsApiWrongServerException','P2P fallback','queue-age limit'])
        with self.assertRaises(ValueError): content_labels(['WrongServer'],content)
        self.assertEqual(content_labels(['P2P   fallback'],content),['P2P fallback'])

    def test_punctuation_and_unicode_labels_do_not_collapse(self):
        content='C++ uses a/b while C# uses a-b. 队列等待需要限流。'
        labels=content_labels(['C++','C#','a/b','a-b','队列等待'],content)
        tags,_=tags_for({'status':'unresolved','content_tags':json.dumps(labels)})
        self.assertEqual(len([tag for tag in tags if tag.startswith('topic:')]),5)
        self.assertIn('topic:c++',tags)
        self.assertIn('topic:c#',tags)
        with self.assertRaises(ValueError): content_labels(['https://example.com'],content)
        with self.assertRaises(ValueError): content_labels('DSAPI','DSAPI')

    def test_owned_system_tags_migrate_but_manual_tags_survive(self):
        previous={'managed_tags':json.dumps(['source:workiq-thread','system:dsapi','status:unresolved'])}
        meta={'status':'unresolved','content_tags':json.dumps(['queue age'])}
        tags,owned=tags_for(meta,['system:dsapi','system:manual','user:keep','source:workiq-thread','status:unresolved'],previous)
        self.assertNotIn('system:dsapi',tags)
        self.assertIn('system:manual',tags)
        self.assertIn('user:keep',tags)
        self.assertIn('topic:queue-age',owned)

    def test_managed_status_changes_preserve_user_tags(self):
        before = {'status':'unresolved','content_tags':json.dumps(['DSAPI'])}
        tags, managed = tags_for(before, ['user:important', 'topic:user-service'])
        metadata = {'status':'resolved','content_tags':json.dumps(['PAPI'])}
        updated, current = tags_for(metadata, tags, {'managed_tags':json.dumps(managed)})
        self.assertNotIn('status:unresolved',updated)
        self.assertNotIn('topic:dsapi',updated)
        self.assertIn('status:resolved',updated)
        self.assertIn('topic:papi',updated)
        self.assertIn('user:important',updated)
        self.assertIn('topic:user-service',updated)
        self.assertEqual(tags_for(metadata, updated, {'managed_tags':json.dumps(current)})[0], updated)

    def test_matching_existing_user_label_is_not_claimed(self):
        metadata={'status':'unresolved','content_tags':json.dumps(['DSAPI'])}
        tags,managed=tags_for(metadata,['topic:dsapi'],{})
        self.assertNotIn('topic:dsapi',managed)
        newer={'status':'resolved','content_tags':json.dumps(['PAPI'])}
        updated,_=tags_for(newer,tags,{'managed_tags':json.dumps(managed)})
        self.assertIn('topic:dsapi',updated)

    def test_source_dates_compare_instants_across_timezones(self):
        messages=[{'source_key':'a','metadata':{'sent_at':'2026-09-17T00:30:00+08:00','subject':'Thread'}},
                  {'source_key':'b','metadata':{'sent_at':'2026-09-16T18:00:00Z','subject':'Thread'}}]
        result=source_metadata('Thread outcome',{'source_ids':json.dumps(['a','b'])},messages)
        self.assertEqual(result['first_source_at'],'2026-09-17T00:30:00+08:00')
        self.assertEqual(result['latest_source_at'],'2026-09-16T18:00:00Z')

    def test_source_metadata_only_describes_supporting_messages(self):
        messages = [{'source_key':'a','metadata':{'subject':'RE: A service issue','sender_name':'Alice','sender':'a@example.invalid','sent_at':'2026-09-16T01:00:00Z','folder_id':'inbox','source_url':'https://outlook.office.com/a'}},
                    {'source_key':'b','metadata':{'subject':'RE: A service issue','sender_name':'Bob','sent_at':'2026-09-17T01:00:00Z'}}]
        value=source_metadata('DSAPI outcome',{'source_ids':json.dumps(['a']),'status':'unresolved'},messages,content_tags=['DSAPI'])
        self.assertEqual(value['subject'],'A service issue')
        self.assertEqual(json.loads(value['source_authors']),['Alice'])
        self.assertEqual(value['source_message_count'],'1')
        self.assertEqual(value['first_source_at'],'2026-09-16T01:00:00Z')
        self.assertNotIn('owner',value)
        self.assertEqual(json.loads(value['source_messages'])[0]['id'],'a')

if __name__ == '__main__': unittest.main()
