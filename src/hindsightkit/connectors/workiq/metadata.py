"""Small, source-grounded labels for a current thread outcome."""
import json
import re
from datetime import datetime, timezone

VERSION = '2'
BASE_TAGS = {'source:workiq-thread', 'kind:thread-outcome'}


def content_labels(values, content):
    """Validate retrieval labels without assigning special rules to entity types."""
    if not isinstance(values, list):
        raise ValueError('Content labels must be a list.')
    result = {}
    for value in values:
        if not isinstance(value, str):
            raise ValueError('Invalid content label.')
        value = ' '.join(value.split())
        if not 2 <= len(value) <= 64 or not any(char.isalpha() for char in value) or any(
                not (char.isalnum() or char in ' ._/-+#') for char in value):
            raise ValueError('Invalid content label.')
        pattern = r'(?<![A-Za-z0-9_])' + r'\s+'.join(re.escape(part) for part in value.split()) + r'(?![A-Za-z0-9_])'
        match = re.search(pattern, content, re.I)
        if match is None:
            raise ValueError('A content label must occur in the accepted outcome.')
        canonical = ' '.join(match.group().split())
        result.setdefault(canonical.casefold(), canonical)
    if len(result) > 5:
        raise ValueError('At most five content labels are supported.')
    return [result[key] for key in sorted(result)]


def tags_for(metadata, previous=(), previous_metadata=None):
    """Refresh owned labels; preserve every unrelated user-created tag."""
    owned = set(json.loads((previous_metadata or metadata).get('managed_tags', '[]')))
    old = {tag for tag in previous if tag not in owned}
    labels = json.loads(metadata.get('content_tags', '[]'))
    managed = BASE_TAGS | {'status:' + metadata['status']}
    managed.update('topic:' + '-'.join(label.casefold().split()) for label in labels)
    return sorted(old | managed), sorted(managed - old)


def _sent(message):
    meta = message['metadata']
    value = meta.get('sent_at') or meta.get('received_at')
    return datetime.fromisoformat(value.replace('Z', '+00:00')) if value else datetime.min.replace(tzinfo=timezone.utc)

def source_metadata(content, metadata, messages, *, content_tags=None):
    """Describe supporting source messages without putting envelopes into memory text."""
    result = dict(metadata)
    names = content_labels(content_tags if content_tags is not None else json.loads(result.get('content_tags', '[]')), content)
    result.pop('systems', None)
    selected = set(json.loads(result.get('source_ids', '[]')))
    supporting = [message for message in messages if message['source_key'] in selected]
    ordered = sorted(supporting, key=lambda m: (_sent(m), m['source_key']))
    result.update(title=content.splitlines()[0].strip(), content_tags=json.dumps(names, ensure_ascii=False), labels_version=VERSION)
    if ordered:
        result['subject'] = re.sub(r'^(?:(?:re|fw|fwd):\s*)+', '', ordered[0]['metadata'].get('subject', '').strip(), flags=re.I)
        sources = []
        for message in ordered:
            meta = message['metadata']
            sources.append({key: value for key, value in {
                'id':message['source_key'], 'author':meta.get('sender_name'), 'address':meta.get('sender'),
                'sent_at':meta.get('sent_at'), 'received_at':meta.get('received_at'),
                'folder_id':meta.get('folder_id'), 'folder':meta.get('folder_path'), 'url':meta.get('source_url')
            }.items() if value})
        result['source_messages'] = json.dumps(sources, ensure_ascii=False, sort_keys=True)
        result['source_message_count'] = str(len(sources))
        result['source_authors'] = json.dumps(sorted({s['author'] for s in sources if s.get('author')}), ensure_ascii=False)
        dates = sorted((s['sent_at'] for s in sources if s.get('sent_at')), key=lambda value: datetime.fromisoformat(value.replace('Z', '+00:00')))
        if dates:
            result['first_source_at'], result['latest_source_at'] = dates[0], dates[-1]
        result['folder_ids'] = json.dumps(sorted({s['folder_id'] for s in sources if s.get('folder_id')}))
        result['source_folders'] = json.dumps(sorted({s['folder'] for s in sources if s.get('folder')}))
    return result
