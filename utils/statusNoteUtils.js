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
    const nestedStatusNote = value.statusNote != null ? value.statusNote : null;
    if (nestedStatusNote != null) {
      const nestedResult = extractStatusNotePayload(nestedStatusNote);
      if (nestedResult) return nestedResult;
    }

    const source = value;
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

function _toIso(value) {
  if (!value) return null;
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch (e) {
    return null;
  }
}

function normalizeStatusList(value) {
  if (!value) return [];
  if (!Array.isArray(value)) value = [value];
  const out = [];
  for (const item of value) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const note = item.trim();
      if (note) out.push({ note, color: null, createdAt: null });
      continue;
    }

    if (typeof item === 'object') {
      const src = item.statusNote && typeof item.statusNote === 'object' ? item.statusNote : item;
      const note = src && src.note != null ? String(src.note).trim() : null;
      const color = src && src.color != null ? String(src.color).trim() : null;
      const createdAt = _toIso(src.createdAt || src.created_at || item.createdAt || item.created_at || null);
      if (note || color || createdAt) {
        out.push({ note: note || null, color: color || null, createdAt });
      }
    }
  }
  return out;
}

function pickLatestStatus(statusList = []) {
  if (!Array.isArray(statusList) || statusList.length === 0) return null;
  // Prefer items with createdAt; fall back to insertion order
  const withDate = statusList.filter(s => s && s.createdAt).slice();
  if (withDate.length) {
    withDate.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return withDate[0];
  }
  return statusList[statusList.length - 1] || null;
}

module.exports = {
  extractStatusNotePayload,
  normalizeStatusList,
  pickLatestStatus,
};
