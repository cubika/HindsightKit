"""Skip complete, standalone routine templates before outcome inference."""
import hashlib
import re


_QUOTED = re.compile(
    r'\[Earlier quoted message; author and date not verified\]|^\s*>|'
    r'^\s*(?:From|Sent|To|Subject):|^On .{1,300} wrote:|'
    r'-{2,}\s*(?:Original Message|Forwarded message)', re.I | re.M)
_REPLY = re.compile(r'^(?:re|fw|fwd|回复|答复|转发)\s*[:：]', re.I)
_FINDING = re.compile(
    r'\b(?:root cause|fixed by|resolved by|caused by|investigat\w*|workaround|'
    r'mitigat\w*|regression|rollback|outage|postmortem|deadlock|exception|'
    r'diagnos\w*|reproduc\w*|observed|measured|confirmed|verified|failed|'
    r'latency|data loss|unauthorized|incident\s*(?:#|\d)|'
    r'(?:we|I)\s+(?:found|discovered|learned|noticed|fixed|resolved))\b|'
    r'\b(?:note|update|finding|correction|additional context)\s*:', re.I)

_PIM_FOOTER = (
    'Privileged Identity Management protects your organization from accidental or malicious '
    'activity by reducing persistent access to Azure resources, providing just-in-time or '
    'time-limited access when needed.')
_CORPORATE_ADDRESS = 'Microsoft Corporation, One Microsoft Way, Redmond, WA 98052'
# The complete static reminder must match; additions and revised templates go to inference.
_AWARD_BODY_SHA256 = '43b677844b6aeaa19f0f1871f73ae2c54b5b9d08c4ebce7db0957d48a52d2e18'


def _normalized(value):
    return ' '.join(value.split())


def _pim(subject, lines):
    match = re.fullmatch(r'PIM: ([\w@.+-]{1,160}) activated the ([\w -]{1,100}) role assignment', subject, re.I)
    if not match or len(lines) != 17:
        return False
    actor, role = match.groups()
    if not re.fullmatch(r'[\w .()-]{1,100} \(ID: [0-9a-f-]{36}\)', lines[0], re.I):
        return False
    if not lines[7].startswith('Resource '):
        return False
    resource = lines[7].removeprefix('Resource ')
    if not re.fullmatch(r'[\w .()-]{1,120}', resource):
        return False
    expected = {
        1: f'{actor} activated the {role} role for the {resource} subscription',
        2: 'View the activation history for this user in the Privileged Identity Management (PIM) portal.',
        3: 'View history >', 4: 'Settings Value', 5: 'User or Group ' + actor,
        6: 'Role ' + role, 8: 'Resource type subscription', 9: 'Activated by ' + actor,
        13: _PIM_FOOTER, 14: 'Privacy Statement', 15: _CORPORATE_ADDRESS, 16: 'Facilitated by',
    }
    if any(lines[index] != value for index, value in expected.items()):
        return False
    return (all(re.fullmatch(label + r' [A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} UTC', lines[index])
                for index, label in ((10, 'Start'), (11, 'End')))
            and bool(re.fullmatch(r'Justification (?:dev|development|test|testing|maintenance|administration)', lines[12], re.I)))


def _learning_agenda(subject, lines):
    if len(lines) != 11 or [lines[i] for i in (0, 2, 4, 6, 8)] != ['Topic', 'Speaker', 'Category', 'Language', 'Description']:
        return False
    if any(not 1 <= len(lines[i]) <= 160 for i in (1, 3, 5, 7)) or not 20 <= len(lines[9]) <= 2200:
        return False
    return (bool(re.fullmatch(re.escape(lines[1]) + r' - [\w -]{1,80} Learning Day FY\d{2} Q[1-4]', subject))
            and bool(re.fullmatch(r'FY\d{2} Q[1-4] [\w -]{1,80} Learning Day Agenda: Learning Day', lines[10])))


def _learning_invitation(subject, lines):
    if len(lines) != 23 or not subject.startswith('[M365Core FHL] '):
        return False
    if lines[0] != subject.removeprefix('[M365Core FHL] ') or lines[1] != 'Speakers:' or not 1 <= len(lines[2]) <= 160:
        return False
    # The free text is limited to the invitation's future-tense description slots.
    if (not re.fullmatch(r'In this session, .{1,150} will .{20,1600}', lines[3])
            or not re.fullmatch(r'[\w .-]{1,100} will .{20,1600}', lines[4])
            or not re.fullmatch(r'[\w .-]{1,100} will then .{20,1600}', lines[5])
            or not lines[7].startswith('Anyone interested in ') or len(lines[7]) > 700):
        return False
    expected = {
        6: '👥 Who Should Attend:', 8: 'Level:', 9: 'Open to All.',
        10: 'No coding experience required;',
        11: 'some familiarity with Copilot or other AI assistants is helpful.',
        12: 'M365 Core FHL – a dedicated week for employees to gain knowledge and expand skills.',
        13: 'It’s your unique opportunity to FIX an existing product, HACK something new, and LEARN new skills.',
        14: 'Choose your FHL learning journey!',
        15: 'Sessions are optional, so join the ones that interest you and support your learning goals.',
        16: '📺 Watch recorded sessions: click HERE',
        17: '📅 View the full learning schedule: click HERE',
        18: '🎤 Interested in leading a session? Sign up HERE',
        22: 'Find a local number',
    }
    if any(lines[index] != value for index, value in expected.items()):
        return False
    return (bool(re.fullmatch(r'❓Questions\? Contact [\w .-]{1,100}', lines[19]))
            and all(re.fullmatch(r'[+()\d, #.-]+ [A-Za-z ,()-]{1,100}', line) for line in lines[20:22]))


def routine_thread_reason(messages) -> str | None:
    """Return a reason only for a complete single-message routine template."""
    if not isinstance(messages, (list, tuple)) or len(messages) != 1:
        return None
    message = messages[0]
    if not isinstance(message, dict) or message.get('error') or message.get('skip_reason'):
        return None
    metadata, content = message.get('metadata'), message.get('content')
    if not isinstance(metadata, dict) or not isinstance(content, str) or not content.strip() or len(content) > 12_000:
        return None
    subject = metadata.get('subject')
    if not isinstance(subject, str) or not metadata.get('thread_id') or metadata.get('has_quoted_content') is not False:
        return None
    # Missing quote metadata is uncertain. Inspect the original text as well when available.
    original = message.get('source_text', content)
    if not isinstance(original, str) or not original.strip():
        return None
    if (_REPLY.match(subject.strip()) or _QUOTED.search(content) or _QUOTED.search(original)
            or _FINDING.search(content) or _FINDING.search(original)):
        return None
    lines = [_normalized(line) for line in content.splitlines() if line.strip()]
    if _pim(subject.strip(), lines):
        return 'role_activation_template'
    if (re.fullmatch(r'(?:Action Required: Please|Please) accept your Stock Award', subject.strip(), re.I)
            and hashlib.sha256(_normalized(content).encode()).hexdigest() == _AWARD_BODY_SHA256):
        return 'award_acceptance_template'
    if _learning_agenda(subject.strip(), lines):
        return 'learning_agenda_template'
    if _learning_invitation(subject.strip(), lines):
        return 'learning_invitation_template'
    return None
