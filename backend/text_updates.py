"""Apply focused edits to Y.Text while retaining unchanged CRDT characters."""
from difflib import SequenceMatcher


def text_edits(before, after):
    """Return character-offset edits; preserve matching lines and text within them."""
    old_lines, new_lines = before.splitlines(keepends=True), after.splitlines(keepends=True)
    old_offsets, new_offsets = [0], [0]
    for line in old_lines: old_offsets.append(old_offsets[-1] + len(line))
    for line in new_lines: new_offsets.append(new_offsets[-1] + len(line))
    edits = []
    for kind, i, j, k, end in SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes():
        if kind == 'equal': continue
        start, stop = old_offsets[i], old_offsets[j]
        replacement = after[new_offsets[k]:new_offsets[end]]
        if kind != 'replace':
            edits.append((start, stop, replacement))
            continue
        old = before[start:stop]
        for part, a, b, c, d in SequenceMatcher(None, old, replacement, autojunk=False).get_opcodes():
            if part != 'equal': edits.append((start + a, start + b, replacement[c:d]))
    return edits


def update_ydoc_text(ydoc, content):
    text = ydoc.get_text('content')
    before = str(text)
    if before == content: return
    edits = text_edits(before, content)
    # y-py's default YDoc indexes text in UTF-8 bytes, not Python characters.
    byte_offsets = [0]
    for character in before:
        byte_offsets.append(byte_offsets[-1] + len(character.encode('utf-8')))
    with ydoc.begin_transaction() as transaction:
        for start, stop, replacement in reversed(edits):
            offset = byte_offsets[start]
            length = byte_offsets[stop] - offset
            if length: text.delete_range(transaction, offset, length)
            if replacement: text.insert(transaction, offset, replacement)
