import json
import unittest
from hindsightkit.mail_metadata import source_metadata, system_names, tags_for

class MetadataTests(unittest.TestCase):
    def test_system_labels_must_exist_in_outcome(self):
        self.assertEqual(system_names(['DSAPI','dsapi','Admin API'], 'DSAPI uses Admin API.'), ['Admin API','dsapi'])
        for label in ['not-in-text','DSAPI: admin','person@example.invalid']:
            with self.assertRaises(ValueError): system_names([label], 'DSAPI uses Admin API.')

    def test_managed_status_changes_preserve_user_tags(self):
        before = {'status':'unresolved','systems':json.dumps(['DSAPI'])}
        tags, managed = tags_for(before, ['user:important', 'system:user-service'])
        metadata = {'status':'resolved','systems':json.dumps(['PAPI'])}
        updated, current = tags_for(metadata, tags, {'managed_tags':json.dumps(managed)})
        self.assertNotIn('status:unresolved',updated)
        self.assertNotIn('system:dsapi',updated)
        self.assertIn('status:resolved',updated)
        self.assertIn('system:papi',updated)
        self.assertIn('user:important',updated)
        self.assertIn('system:user-service',updated)
        self.assertEqual(tags_for(metadata, updated, {'managed_tags':json.dumps(current)})[0], updated)

    def test_matching_existing_user_label_is_not_claimed(self):
        metadata={'status':'unresolved','systems':json.dumps(['DSAPI'])}
        tags,managed=tags_for(metadata,['system:dsapi'],{})
        self.assertNotIn('system:dsapi',managed)
        newer={'status':'resolved','systems':json.dumps(['PAPI'])}
        updated,_=tags_for(newer,tags,{'managed_tags':json.dumps(managed)})
        self.assertIn('system:dsapi',updated)

    def test_source_dates_compare_instants_across_timezones(self):
        messages=[{'source_key':'a','metadata':{'sent_at':'2026-09-17T00:30:00+08:00','subject':'Thread'}},
                  {'source_key':'b','metadata':{'sent_at':'2026-09-16T18:00:00Z','subject':'Thread'}}]
        result=source_metadata('Thread outcome',{'source_ids':json.dumps(['a','b'])},messages)
        self.assertEqual(result['first_source_at'],'2026-09-17T00:30:00+08:00')
        self.assertEqual(result['latest_source_at'],'2026-09-16T18:00:00Z')

    def test_source_metadata_only_describes_supporting_messages(self):
        messages = [{'source_key':'a','metadata':{'subject':'RE: A service issue','sender_name':'Alice','sender':'a@example.invalid','sent_at':'2026-09-16T01:00:00Z','folder_id':'inbox','source_url':'https://outlook.office.com/a'}},
                    {'source_key':'b','metadata':{'subject':'RE: A service issue','sender_name':'Bob','sent_at':'2026-09-17T01:00:00Z'}}]
        value=source_metadata('DSAPI outcome',{'source_ids':json.dumps(['a']),'status':'unresolved'},messages,systems=['DSAPI'])
        self.assertEqual(value['subject'],'A service issue')
        self.assertEqual(json.loads(value['source_authors']),['Alice'])
        self.assertEqual(value['source_message_count'],'1')
        self.assertEqual(value['first_source_at'],'2026-09-16T01:00:00Z')
        self.assertNotIn('owner',value)
        self.assertEqual(json.loads(value['source_messages'])[0]['id'],'a')

if __name__ == '__main__': unittest.main()
