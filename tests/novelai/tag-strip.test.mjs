// Tag 过滤规则：原样删词（不分大小写）、清理逗号、开关、只动 LLM 字段；compile() 发出的请求用剥过的 tag。
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const { stripTags, stripTaskTags, normalizeTagStripRules } = await import('../../modules/draw/shared/tag-strip.js');
const { compile } = await import('../../modules/draw/providers/novelai/compiler.js');

test('原样删词、不分大小写、清理多余逗号；没匹配上原样返回', () => {
    const rules = [{ text: 'nsfw', enabled: true }, { text: 'blush', enabled: true }];
    assert.equal(stripTags('1girl, NSFW, smile, blush', rules), '1girl, smile');
    assert.equal(stripTags('0.5::nsfw::, bedroom', rules), '0.5::::, bedroom', '写啥删啥，不猜权重语法');
    assert.equal(stripTags('nsfw', rules), '');
    const untouched = '1girl,  smile ,cat';
    assert.equal(stripTags(untouched, rules), untouched);
});

test('关掉的规则、空词不生效', () => {
    assert.equal(stripTags('1girl, nsfw', [{ text: 'nsfw', enabled: false }]), '1girl, nsfw');
    assert.deepEqual(normalizeTagStripRules([{ text: '  ' }, { text: ' a ' }, null]), [{ text: 'a', enabled: true }]);
});

test('任务：剥场景和角色外貌/服装/动作/互动，负面不动；没有开着的规则直接返回原对象', () => {
    const task = { scene: 'bedroom, nsfw', chars: [{ name: 'A', appear: 'nsfw, long hair', action: 'sitting', uc: 'nsfw' }] };
    const rules = [{ text: 'nsfw', enabled: true }];
    const out = stripTaskTags(task, rules);
    assert.equal(out.scene, 'bedroom');
    assert.equal(out.chars[0].appear, 'long hair');
    assert.equal(out.chars[0].uc, 'nsfw');
    assert.equal(task.scene, 'bedroom, nsfw', '不改原任务');
    assert.equal(stripTaskTags(task, [{ text: 'nsfw', enabled: false }]), task);
});

test('compile：请求 payload 和存下的 tags 都用剥过的；固定前缀不剥', () => {
    const recipe = {
        apiBaseUrl: '',
        resolveForBackend: false,
        params: { model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler', scheduler: 'karras' },
        positivePrefix: 'nsfw, masterpiece',
        seeds: [1],
        timeout: 1000,
        requestDelay: { min: 0, max: 0 },
        autoLearnEnabled: false,
        autoLearnMode: 'new_only',
        tagStripRules: [{ text: 'nsfw', enabled: true }],
    };
    const batch = compile([{ scene: '1girl, nsfw, smile', characterPrompts: [] }], recipe);
    const caption = batch.items[0].request.payload.parameters.v4_prompt.caption.base_caption;
    assert.match(caption, /^nsfw, masterpiece/);
    assert.doesNotMatch(caption.replace(/^nsfw, masterpiece/, ''), /nsfw/);
    assert.equal(batch.artifacts[0].tags, '1girl, smile');
    const plain = compile([{ scene: '1girl, nsfw', characterPrompts: [] }], { ...recipe, tagStripRules: undefined });
    assert.equal(plain.artifacts[0].tags, '1girl, nsfw', '没有规则时不变');
});
