// 导出全局配置：默认清空所有 Key，勾选才保留；不改原对象；文件名带时间和「含Key」。
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildSettingsExport, stripSecrets, settingsExportFileName, validateSettingsImport } = await import('../../modules/draw/shared/settings-export.js');

test('导入检查：只认小黑生图导出的配置；列出有哪几块；备份文件名带标签', () => {
    const good = buildSettingsExport({ provider: { apiKey: '' }, shared: {}, sceneAgent: null });
    assert.deepEqual(validateSettingsImport(good), { ok: true, error: '', sections: ['novelDraw', 'sharedDraw'] });
    assert.equal(validateSettingsImport({ app: 'other' }).ok, false);
    assert.equal(validateSettingsImport([]).ok, false);
    assert.equal(validateSettingsImport({ app: 'xiaohei-draw', kind: 'global-settings' }).ok, false);
    assert.equal(settingsExportFileName(new Date(2026, 8, 16, 9, 5), true, '导入前备份'), '小黑生图配置-导入前备份-20260916-0905-含Key.json');
});

const provider = { apiKey: 'pst-secret', apiBaseUrl: 'https://x', paramsPresets: [{ id: 'p1', name: '默认' }] };
const shared = { tagStripRules: [{ text: 'nsfw', enabled: true }], messageFilterRules: [] };
const sceneAgent = {
    currentPresetName: '默认',
    presets: { 默认: { provider: 'openai-compatible', modelConfigs: { 'openai-compatible': { baseUrl: 'https://llm', apiKey: 'sk-abc', model: 'm' } } } },
    tavilyApiKey: 'tvly-1',
};

test('默认不带 Key：所有密钥字段清空，其他内容原样', () => {
    const out = buildSettingsExport({ provider, shared, sceneAgent, now: new Date(2026, 8, 16, 9, 5) });
    assert.equal(out.includesKeys, false);
    assert.equal(out.novelDraw.apiKey, '');
    assert.equal(out.novelDraw.apiBaseUrl, 'https://x');
    assert.equal(out.sceneAgent.presets.默认.modelConfigs['openai-compatible'].apiKey, '');
    assert.equal(out.sceneAgent.presets.默认.modelConfigs['openai-compatible'].model, 'm');
    assert.equal(out.sceneAgent.tavilyApiKey, '');
    assert.deepEqual(out.sharedDraw.tagStripRules, shared.tagStripRules);
    assert.doesNotMatch(JSON.stringify(out), /pst-secret|sk-abc|tvly-1/);
    assert.equal(provider.apiKey, 'pst-secret', '不改原对象');
});

test('勾选带 Key：原样保留', () => {
    const out = buildSettingsExport({ provider, shared, sceneAgent, includeKeys: true });
    assert.equal(out.includesKeys, true);
    assert.equal(out.novelDraw.apiKey, 'pst-secret');
    assert.equal(out.sceneAgent.presets.默认.modelConfigs['openai-compatible'].apiKey, 'sk-abc');
});

test('stripSecrets 只清字符串密钥，不误伤对象和普通字段；文件名', () => {
    assert.deepEqual(stripSecrets({ key: 'k', keywordFilterMode: 'auto', token: 't', nested: [{ password: 'p' }] }), { key: 'k', keywordFilterMode: 'auto', token: '', nested: [{ password: '' }] });
    const d = new Date(2026, 8, 16, 9, 5);
    assert.equal(settingsExportFileName(d), '小黑生图配置-20260916-0905.json');
    assert.equal(settingsExportFileName(d, true), '小黑生图配置-20260916-0905-含Key.json');
});
