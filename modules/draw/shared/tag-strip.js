// Tag 过滤规则：LLM 生成的 tag 送进 NAI 前，按用户写的词原样删掉（不区分大小写），再清理多出来的逗号。
// 纯函数，compiler（node 可测）和设置页共用口径。

/** [{ text, enabled }]：去掉空词，enabled 缺省为开。 */
export function normalizeTagStripRules(list) {
    return (Array.isArray(list) ? list : [])
        .filter(rule => rule && typeof rule === 'object')
        .map(rule => ({ text: String(rule.text || '').trim(), enabled: rule.enabled !== false }))
        .filter(rule => rule.text);
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 删掉所有开着的词；一个都没匹配上就原样返回。 */
export function stripTags(text, rules) {
    const source = String(text ?? '');
    const active = normalizeTagStripRules(rules).filter(rule => rule.enabled);
    if (!source || !active.length) return source;
    let result = source;
    for (const rule of active) {
        result = result.replace(new RegExp(escapeRegExp(rule.text), 'gi'), '');
    }
    if (result === source) return source;
    return result
        .split(',')
        .map(piece => piece.replace(/[ \t]{2,}/g, ' ').trim())
        .filter(Boolean)
        .join(', ');
}

const CHARACTER_TAG_FIELDS = ['appear', 'costume', 'action', 'interact'];

/** 一个场景任务：剥场景 tag 和 LLM 写的角色字段（外貌 / 服装 / 动作 / 互动）；负面、用户角色库、固定前缀不动。 */
export function stripTaskTags(task, rules) {
    if (!task || typeof task !== 'object' || !normalizeTagStripRules(rules).some(rule => rule.enabled)) return task;
    const next = { ...task };
    if (typeof task.scene === 'string') next.scene = stripTags(task.scene, rules);
    if (Array.isArray(task.chars)) {
        next.chars = task.chars.map((character) => {
            if (!character || typeof character !== 'object') return character;
            const copy = { ...character };
            for (const field of CHARACTER_TAG_FIELDS) {
                if (typeof copy[field] === 'string') copy[field] = stripTags(copy[field], rules);
            }
            return copy;
        });
    }
    return next;
}
