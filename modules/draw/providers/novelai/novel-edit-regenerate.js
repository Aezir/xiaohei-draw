// novel-edit-regenerate.js
// 聊天图片「编辑提示词」窗口的「保存并重新生成」流程（纯流程编排，node 可测；真实的保存 / 生成由 novel-draw.js 注入）。
// 顺序：校验 → 保存 → 花费规则（需要时页内确认）→ 重新生成一次。
// 确认被取消：提示词已经保存，只是不生成（Esc / 点遮罩 = 最安全的选项）。
// 同一张卡正在走流程时，再点按钮直接忽略，保证只生成一次。

const inFlight = new WeakSet();

/**
 * @param {object} key  用来防重入的对象（卡片元素）
 * @param {object} deps
 *   validate(): string|''     返回非空字符串 = 错误信息，流程停止（不保存不生成）
 *   save(): Promise<void>
 *   check(): { confirm: boolean, reasons: string[] }   花费规则（novel-cost-rule.js）
 *   confirm(reasons): Promise<boolean>                 页内对话框
 *   regenerate(): Promise<void>
 *   alert(message), notify(message)
 * @returns {Promise<'invalid'|'busy'|'cancelled'|'regenerated'>}
 */
export async function saveAndRegenerate(key, deps) {
    if (inFlight.has(key)) return 'busy';
    const error = deps.validate?.() || '';
    if (error) {
        await deps.alert?.(error);
        return 'invalid';
    }
    inFlight.add(key);
    try {
        await deps.save();
        const rule = deps.check?.() || { confirm: false, reasons: [] };
        if (rule.confirm) {
            const ok = await deps.confirm(rule.reasons || []);
            if (!ok) {
                deps.notify?.('提示词已保存，未重新生成');
                return 'cancelled';
            }
        }
        await deps.regenerate();
        return 'regenerated';
    } finally {
        inFlight.delete(key);
    }
}
