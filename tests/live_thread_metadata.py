"""Verify official metadata/tag updates preserve one unchanged thread outcome."""
import asyncio
import json
import uuid
from hindsightkit.connection import sdk, server_load
from hindsightkit.mail_metadata import tags_for

async def main():
    client=sdk(server_load(),timeout=30)
    bank='hindsightkit-label-test-'+uuid.uuid4().hex[:10]
    content='A DSAPI thread outcome with a confirmed service scope.'
    report={}
    try:
        await client.acreate_bank(bank_id=bank,retain_extraction_mode='chunks',retain_chunk_size=8000,enable_observations=False)
        await client.aretain(bank_id=bank,document_id='thread',content=content,metadata={'status':'unresolved'},tags=['user:important'])
        before=await client.documents.get_document(bank_id=bank,document_id='thread')
        metadata={'status':'unresolved','content_tags':json.dumps(['DSAPI'])}
        tags,managed=tags_for(metadata,before.tags,before.document_metadata)
        metadata['managed_tags']=json.dumps(managed)
        await client.aretain(bank_id=bank,document_id='thread',content=content,metadata=metadata,tags=tags,update_mode='replace')
        after=await client.documents.get_document(bank_id=bank,document_id='thread')
        facts=await client.alist_memories(bank_id=bank,limit=100)
        assert after.content_hash==before.content_hash and after.original_text==content
        assert after.memory_unit_count==facts.total==1
        assert set(after.tags)==set(facts.items[0].tags)==set(tags)
        assert facts.items[0].metadata['content_tags']==metadata['content_tags']
        included=await client.arecall(bank_id=bank,query='DSAPI',types=['world'],tags=['topic:dsapi'],tags_match='all_strict')
        excluded=await client.arecall(bank_id=bank,query='DSAPI',types=['world'],tags=['status:resolved'],tags_match='all_strict')
        assert len(included.results)==1 and not excluded.results
        report.update(content_unchanged=True,one_memory=True,user_tag_preserved=True,tag_filter_verified=True)
    finally:
        await client.adelete_bank(bank_id=bank)
        report['test_bank_deleted']=not (await client.banks.list_banks(q=bank,limit=100)).banks
        await client.aclose()
    print(json.dumps(report))

if __name__=='__main__':asyncio.run(main())
