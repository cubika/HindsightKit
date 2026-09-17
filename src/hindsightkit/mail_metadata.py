"""Small, source-grounded labels for a current thread outcome."""
import json
import re
from datetime import datetime, timezone

VERSION = '1'
BASE_TAGS = {'source:workiq-thread', 'kind:thread-outcome'}


def system_names(values, content):
    result = {}
    for value in values:
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9 ._/-]{0,63}', value):
            raise ValueError('Invalid system label.')
        value = value.strip()
        if not re.search(r'(?<![A-Za-z0-9])' + re.escape(value) + r'(?![A-Za-z0-9])', content, re.I):
            raise ValueError('A system label must occur in the accepted outcome.')
        result[value.casefold()] = value
    if len(result) > 5:
        raise ValueError('At most five system labels are supported.')
    return [result[key] for key in sorted(result)]


def tags_for(metadata, previous=(), previous_metadata=None):
    """Refresh owned labels; preserve every unrelated user-created tag."""
    owned = set(json.loads((previous_metadata or metadata).get('managed_tags', '[]')))
    # Only labels recorded as connector-owned may be replaced.
    old = {tag for tag in previous if tag not in owned}
    systems = json.loads(metadata.get('systems', '[]'))
    managed = BASE_TAGS | {'status:' + metadata['status']}
    managed.update('system:' + re.sub(r'[^a-z0-9]+', '-', name.casefold()).strip('-') for name in systems)
    return sorted(old | managed), sorted(managed - old)


def _sent(message):
    meta = message['metadata']
    value = meta.get('sent_at') or meta.get('received_at')
    return datetime.fromisoformat(value.replace('Z', '+00:00')) if value else datetime.min.replace(tzinfo=timezone.utc)

def source_metadata(content, metadata, messages, *, systems=None):
    """Describe supporting source messages without putting envelopes into memory text."""
    result = dict(metadata)
    names = system_names(systems if systems is not None else json.loads(result.get('systems', '[]')), content)
    selected = set(json.loads(result.get('source_ids', '[]')))
    supporting = [message for message in messages if message['source_key'] in selected]
    ordered = sorted(supporting, key=lambda m: (_sent(m), m['source_key']))
    result.update(title=content.splitlines()[0].strip(), systems=json.dumps(names), labels_version=VERSION)
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
