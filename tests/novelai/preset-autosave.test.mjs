// 参数预设 / 提示词预设改为改动即自动保存：静态检查设置页和宿主的接线没有退回「点保存」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = rel => readFileSync(join(root, rel), 'utf8');
const html = read('modules/draw/providers/novelai/novel-draw.html');
const host = read('modules/draw/providers/novelai/novel-draw.js');
const costBar = read('modules/draw/providers/novelai/ui/nd-cost-bar.js');
const vibe = read('modules/draw/providers/novelai/ui/novel-vibe-panel.js');

function fnBody(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} missing`);
    return src.slice(start, src.indexOf('\n}\n', start));
}

test('显式保存按钮已移除，文案不再要求点保存', () => {
    for (const id of ['nd_params_save', 'nd_prompt_preset_save', 'nd_prompts_save']) {
        assert.ok(!html.includes(id), `${id} should be gone`);
    }
    for (const src of [html, costBar, vibe]) {
        assert.doesNotMatch(src, /点保存|先保存|需点击保存|不自动保存/);
    }
});

test('防抖自动保存：500ms，程序填表时不触发', () => {
    assert.match(html, /const AUTOSAVE_DELAY_MS = 500;/);
    assert.match(fnBody(html, 'scheduleParamsSave'), /formPopulating > 0\) return/);
    assert.match(fnBody(html, 'schedulePromptSave'), /formPopulating > 0\) return/);
    assert.match(fnBody(html, 'applyParamsPreset'), /formPopulating\+\+[\s\S]*finally[\s\S]*formPopulating--/);
    assert.match(fnBody(html, 'flushParamsSave'), /type: 'SAVE_PARAMS_PRESET',\s*autosave: true/);
    assert.match(fnBody(html, 'flushPromptSave'), /type: 'SAVE_PROMPT_PRESET',\s*autosave: true/);
});

test('冲刷时机：切页、页面隐藏/卸载、生成前、切预设', () => {
    assert.match(fnBody(html, 'switchView'), /flushAutosaves\(\)/);
    assert.match(html, /addEventListener\('pagehide', \(\) => flushAutosaves\(\)\)/);
    assert.match(html, /visibilityState === 'hidden'\) flushAutosaves\(\)/);
    assert.match(html, /\$\('nd_test_single'\)\.addEventListener\('click', async \(\) => \{[\s\S]{0,200}flushParamsSave\(\)/);
    assert.match(html, /\$\('nd_params_preset'\)\.addEventListener\('change', \(\) => \{\s*flushParamsSave\(\);/);
    assert.match(html, /\$\('nd_prompt_preset'\)\.addEventListener\('change', \(\) => \{\s*flushPromptSave\(\);/);
});

test('氛围卡只有用户改动才触发保存（edit 标记）', () => {
    assert.match(vibe, /function notifyChange\(edit = false\)/);
    assert.match(html, /nd:vibes-change[\s\S]{0,80}event\.detail\?\.edit\) scheduleParamsSave\(\)/);
});

test('宿主：自动保存成功不回传 INIT_DATA；TEST_SINGLE 等待设置写入', () => {
    const params = host.slice(host.indexOf("case 'SAVE_PARAMS_PRESET'"), host.indexOf("case 'IMPORT_GALLERY_PRESET'"));
    assert.match(params, /if \(!data\.autosave\) sendInitData\(\)/);
    assert.match(params, /settings\.paramsPresets\[index\] = single/);
    const prompt = host.slice(host.indexOf("case 'SAVE_PROMPT_PRESET'"), host.indexOf("case 'SAVE_WORLDBOOK_CONFIG'"));
    assert.match(prompt, /if \(data\.autosave && saved\) break;/);
    const single = host.slice(host.indexOf("case 'TEST_SINGLE'"));
    assert.match(single, /await settingsUpdateQueue;[\s\S]{0,40}getActiveParamsPreset\(\)/);
});
