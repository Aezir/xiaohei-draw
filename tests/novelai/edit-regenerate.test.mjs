// 编辑提示词窗口「保存并重新生成」：保存一次、生成一次；花费规则决定要不要页内确认；取消 = 保存但不生成。
// 全部 stub，不访问 NovelAI。
import test from 'node:test';
import assert from 'node:assert/strict';

import { saveAndRegenerate } from '../../modules/draw/providers/novelai/novel-edit-regenerate.js';
import { presetGenerateConfirm } from '../../modules/draw/providers/novelai/novel-cost-rule.js';
import { describeCost, needsGenerateConfirm, isV5ModelId } from '../../modules/draw/providers/novelai/ui/nd-cost-bar.js';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

function deps(overrides = {}) {
    const calls = [];
    return {
        calls,
        validate: () => '',
        save: async () => { calls.push('save'); },
        check: () => ({ confirm: false, reasons: [] }),
        confirm: async (reasons) => { calls.push(['confirm', reasons]); return true; },
        regenerate: async () => { calls.push('regenerate'); await new Promise(r => setTimeout(r, 10)); },
        alert: async (m) => { calls.push(['alert', m]); },
        notify: (m) => { calls.push(['notify', m]); },
        ...overrides,
    };
}

const opusVerified = { tier: 3, active: true, usage: { isNegative: false } };
const freePreset = { params: { model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 23 } };

test('免费：保存一次 → 不确认 → 重新生成一次；连点第二下被忽略', async () => {
    const key = {};
    const d = deps({ check: () => presetGenerateConfirm(freePreset, opusVerified) });
    const [a, b] = await Promise.all([saveAndRegenerate(key, d), saveAndRegenerate(key, d)]);
    assert.deepEqual([a, b].sort(), ['busy', 'regenerated']);
    assert.deepEqual(d.calls, ['save', 'regenerate']);
    // 流程结束后可以再来一次
    assert.equal(await saveAndRegenerate(key, d), 'regenerated');
});

test('档位未知（估算为「约」）：先确认，确认后生成', async () => {
    const d = deps({ check: () => presetGenerateConfirm(freePreset, null) });
    assert.equal(await saveAndRegenerate({}, d), 'regenerated');
    assert.equal(d.calls[0], 'save');
    assert.equal(d.calls[1][0], 'confirm');
    assert.match(d.calls[1][1].join(), /档位或免费条件不确定/);
    assert.equal(d.calls[2], 'regenerate');
});

test('确认被取消：提示词已保存，不生成', async () => {
    const d = deps({ check: () => presetGenerateConfirm({ params: { ...freePreset.params, steps: 40 } }, opusVerified), confirm: async () => false });
    assert.equal(await saveAndRegenerate({}, d), 'cancelled');
    assert.deepEqual(d.calls, ['save', ['notify', '提示词已保存，未重新生成']]);
});

test('场景为空：只提示，不保存不生成', async () => {
    const d = deps({ validate: () => '场景 TAG 不能为空' });
    assert.equal(await saveAndRegenerate({}, d), 'invalid');
    assert.deepEqual(d.calls, [['alert', '场景 TAG 不能为空']]);
});

test('生成抛错：锁会释放，错误往上抛给宿主处理', async () => {
    const key = {};
    const d = deps({ regenerate: async () => { throw new Error('boom'); } });
    await assert.rejects(() => saveAndRegenerate(key, d), /boom/);
    assert.equal(await saveAndRegenerate(key, deps()), 'regenerated');
});

test('花费规则：收费 / 超限 / 档位未知都要确认，免费不确认，V5 本身不再是理由；nd-cost-bar 旧导出仍可用', () => {
    assert.equal(presetGenerateConfirm(freePreset, opusVerified).confirm, false);
    assert.equal(presetGenerateConfirm(freePreset, { tier: 1, active: true }).confirm, true);
    assert.equal(presetGenerateConfirm({ params: { ...freePreset.params, model: 'nai-diffusion-5-full' } }, opusVerified).reasons.some(reason => reason.includes('V5')), false);
    assert.equal(presetGenerateConfirm({ params: { ...freePreset.params, width: 1600, height: 1600 } }, opusVerified).confirm, true);
    assert.equal(presetGenerateConfirm({ params: { ...freePreset.params, steps: 40 } }, opusVerified).confirm, true);
    assert.equal(typeof describeCost, 'function');
    assert.equal(isV5ModelId('nai-diffusion-5-curated'), true);
    assert.equal(needsGenerateConfirm({ estimates: [], models: [] }).confirm, false);
});
