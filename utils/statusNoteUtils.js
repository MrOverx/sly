function extractStatusNotePayload(value) {
  if (value == null) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractStatusNotePayload(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? { note: normalized, color: null } : null;
  }

  if (typeof value === 'object') {
    const nestedStatusNote = value.statusNote && typeof value.statusNote === 'object'
      ? value.statusNote
      : null;
    const source = nestedStatusNote || value;
    const note = source && source.note != null ? String(source.note).trim() : null;
    const color = source && source.color != null ? String(source.color).trim() : null;

    if (note || color) {
      return {
        note: note || null,
        color: color || null,
      };
    }
  }

  return null;
}

module.exports = {
  extractStatusNotePayload,
};
