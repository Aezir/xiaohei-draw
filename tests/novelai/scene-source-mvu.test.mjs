// MVU 变量卡正文：过滤规则、插图点、规划后正文尾部被改写时的位置映射。纯函数，不访问网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createSceneSource, findNarrativeTailOffset } from '../../modules/draw/shared/scene-source.js';
import {
    describeNarrativeChange,
    formatNarrativeChange,
    insertScenePlacementsPreservingSlots,
    rebaseScenePlacements,
} from '../../modules/draw/shared/scene-placement.js';
import {
    DEFAULT_MESSAGE_FILTER_RULES,
    MESSAGE_FILTER_RULES_ADDED_IN_V10,
    appendMissingFilterRules,
} from '../../modules/draw/shared/message-filter-rules.js';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const NARRATIVE = '雪落了一整夜。她推开门，看见院子里的脚印。\n\n“有人来过。”她低声说。\n\n远处传来钟声。';
const PLACEHOLDER = '<StatusPlaceHolderImpl/>';

function planAt(sourceText, pointNumbers) {
    const source = createSceneSource(sourceText, { filterRules: DEFAULT_MESSAGE_FILTER_RULES });
    return {
        source,
        placements: pointNumbers.map((number) => {
            const point = source.points.find(item => item.number === number);
            assert.ok(point, `point ${number} exists`);
            return { mode: 'source', insertAfter: number, offset: point.offset, sourceHash: source.sourceHash };
        }),
    };
}

function insert(text, placements, ids = ['a', 'b', 'c']) {
    return insertScenePlacementsPreservingSlots(text, placements.map((placement, index) => ({
        placement,
        content: `[image:${ids[index]}]`,
    })), { block: true });
}

test('默认过滤规则：novel-draw.html 里的副本与 message-filter-rules.js 逐项一致', () => {
    const html = fs.readFileSync(new URL('../../modules/draw/providers/novelai/novel-draw.html', import.meta.url), 'utf8');
    const match = html.match(/const ND_DEFAULT_FILTER_RULES = (\[[\s\S]*?\]);/);
    assert.ok(match, 'ND_DEFAULT_FILTER_RULES found');
    const htmlRules = Function(`return ${match[1]};`)();
    assert.deepEqual(htmlRules, DEFAULT_MESSAGE_FILTER_RULES.map(rule => ({ ...rule })));
});

test('起止相同的规则只删记号本身，不截断前后正文', () => {
    const text = `第一句。${PLACEHOLDER}第二句。\n\n${PLACEHOLDER}`;
    const source = createSceneSource(text, { filterRules: [{ start: PLACEHOLDER, end: PLACEHOLDER }] });
    assert.equal(source.content, '第一句。第二句。');
    // 插图点 offset 仍指向原文里的真实位置
    assert.deepEqual(source.points.map(point => text.slice(0, point.offset)), [
        '第一句。',
        `第一句。${PLACEHOLDER}第二句。`,
    ]);
});

test('默认规则删掉 html 代码块、整页 HTML、状态栏占位符，插图点 offset 绕开被删的块', () => {
    const text = [
        '她走进酒馆。',
        '```html',
        '<div class="hud">体温 36.1</div>',
        '```',
        '<!DOCTYPE html><html><body><p>状态。</p></body></html>',
        '老板抬起头。',
        '',
        PLACEHOLDER,
    ].join('\n');
    const source = createSceneSource(text, { filterRules: DEFAULT_MESSAGE_FILTER_RULES });
    assert.doesNotMatch(source.content, /hud|DOCTYPE|<html|StatusPlaceHolderImpl|```/);
    assert.match(source.content, /她走进酒馆。/);
    assert.match(source.content, /老板抬起头。/);
    const prefixes = source.points.map(point => text.slice(0, point.offset));
    assert.equal(prefixes.length, 2);
    assert.ok(prefixes[0].endsWith('她走进酒馆。'));
    assert.ok(prefixes[1].endsWith('老板抬起头。'));
});

test('开场白形状：<story> 包裹 + CRLF + 尾部状态栏占位符', () => {
    const body = [
        '第一段，雪落在屋檐上。风很冷。',
        '',
        '“你来了？”她问。',
        '',
        '第三段结束了。',
    ].join('\r\n');
    const text = `<story>\r\n${body}\r\n</story>\r\n\r\n${PLACEHOLDER}`;
    const source = createSceneSource(text, { filterRules: DEFAULT_MESSAGE_FILTER_RULES });
    const prefixes = source.points.map(point => text.slice(0, point.offset));
    // 不在 <story> 之后、第一句之前出点；也不在 </story> 或占位符之后出点
    const expectedTails = ['雪落在屋檐上。', '风很冷。', '“你来了？”她问。', '第三段结束了。'];
    assert.equal(prefixes.length, expectedTails.length);
    prefixes.forEach((prefix, index) => assert.ok(prefix.endsWith(expectedTails[index]), JSON.stringify(prefix.slice(-12))));
    assert.ok(source.points.every(point => point.offset <= text.indexOf('</story>')));
    assert.doesNotMatch(source.numberedContent, /StatusPlaceHolderImpl/);

    const { placements } = planAt(text, [source.points.length]);
    const result = insert(text, placements);
    assert.ok(result.indexOf('[image:a]') < result.indexOf('</story>'), 'image stays inside <story>');
    assert.ok(result.endsWith(`</story>\r\n\r\n${PLACEHOLDER}`));
});

test('规划后 MVU 在尾部补上状态栏占位符：图片插在同一叙事位置', () => {
    // 4 个点：一整夜。/ 脚印。/ 她低声说。（引号句与后面的说明合成一个点）/ 钟声。
    const { source, placements } = planAt(NARRATIVE, [1, 4]);
    assert.equal(source.points.length, 4);
    const expected = insert(NARRATIVE, placements);

    const changed = `${NARRATIVE}\n\n${PLACEHOLDER}`;
    const rebased = rebaseScenePlacements(placements, NARRATIVE, changed);
    assert.equal(rebased.rebased, true);
    assert.equal(insert(changed, rebased.placements), `${expected}\n\n${PLACEHOLDER}`);
});

test('规划时正文带 <UpdateVariable> 块，写入前被 MVU 删掉：图片仍插在同一叙事位置', () => {
    const planned = `${NARRATIVE}\n<UpdateVariable>\n_.set('体温', 36);\n</UpdateVariable>\n\n${PLACEHOLDER}`;
    const { placements } = planAt(planned, [2, 4]);
    const expected = insert(planned, placements).replace("\n<UpdateVariable>\n_.set('体温', 36);\n</UpdateVariable>", '');

    const changed = `${NARRATIVE}\n\n${PLACEHOLDER}`;
    const rebased = rebaseScenePlacements(placements, planned, changed);
    assert.equal(insert(changed, rebased.placements), expected);
    assert.ok(expected.indexOf('[image:b]') < expected.indexOf(PLACEHOLDER));
});

test('额外模型解析追加 <UpdateVariable>、占位符挪位、CRLF 尾部空白变化：都能映射', () => {
    const planned = `${NARRATIVE}\r\n\r\n${PLACEHOLDER}`;
    const { placements } = planAt(planned, [3]);
    const changed = `${NARRATIVE}\n\n<UpdateVariable>\n<Analysis>x</Analysis>\n</UpdateVariable>\n\n${PLACEHOLDER}   `;
    const rebased = rebaseScenePlacements(placements, planned, changed);
    const result = insert(changed, rebased.placements);
    assert.ok(result.includes('“有人来过。”她低声说。\n[image:a]'), result);
});

test('真正改了正文：默认按上下文近似定位；allowApproximate: false 才拒绝', () => {
    const { placements } = planAt(NARRATIVE, [2]);
    const edited = NARRATIVE.replace('脚印', '血迹');
    assert.throws(
        () => rebaseScenePlacements(placements, NARRATIVE, `${edited}\n\n${PLACEHOLDER}`, { allowApproximate: false }),
        error => error.code === 'SCENE_SOURCE_CHANGED',
    );
    // 插图点 2 正好在被改的「脚印」后面：前面找不到就用后面那句定位，图仍插在「血迹。」和「有人来过」之间
    const moved = rebaseScenePlacements(placements, NARRATIVE, `${edited}\n\n${PLACEHOLDER}`);
    assert.equal(moved.approximate, true);
    assert.deepEqual(moved.relocated, { anchor: 1, tail: 0 });
    assert.match(insert(`${edited}\n\n${PLACEHOLDER}`, moved.placements), /血迹。\n\n\[image:a\]\n“有人来过/);
    // 改的词不在插图点旁边：按前面那句定位
    const three = planAt(NARRATIVE, [3]);
    const kept = rebaseScenePlacements(three.placements, NARRATIVE, edited);
    assert.deepEqual(kept.relocated, { anchor: 1, tail: 0 });
    assert.match(insert(edited, kept.placements), /她低声说。\n\[image:a\]\n/);
    // 末尾加了一句：位置照旧
    const appended = rebaseScenePlacements(placements, NARRATIVE, `${NARRATIVE}\n\n新加的一句。`);
    assert.equal(appended.approximate, true);
    assert.match(insert(`${NARRATIVE}\n\n新加的一句。`, appended.placements), /她低声说。\n\[image:a\]\n\n远处传来钟声。\n\n新加的一句。/);
    // 插图点前面那句整段被删：找不到锚点，放到叙事末尾（状态栏占位符之前）
    const gutted = '完全不同的开头。\n\n结尾也换了。';
    const tail = rebaseScenePlacements(placements, NARRATIVE, `${gutted}\n\n${PLACEHOLDER}`);
    assert.deepEqual(tail.relocated, { anchor: 0, tail: 1 });
    assert.equal(tail.placements[0].mode, 'tail');
    assert.match(insert(`${gutted}\n\n${PLACEHOLDER}`, tail.placements), /结尾也换了。\n\[image:a\]\n\n<StatusPlaceHolderImpl\/>/);
    // 多张图：单调不乱序
    const two = planAt(NARRATIVE, [1, 2]);
    const both = rebaseScenePlacements(two.placements, NARRATIVE, edited);
    assert.ok(both.placements[0].offset < both.placements[1].offset);
});

test('改动描述：从第几个字起、删了什么、加了什么', () => {
    const change = describeNarrativeChange(NARRATIVE, NARRATIVE.replace('脚印', '血迹'));
    assert.equal(change.removed, '脚印');
    assert.equal(change.added, '血迹');
    assert.match(formatNarrativeChange(change), /^第 \d+ 个字起删了「脚印」、加了「血迹」/);
    assert.equal(describeNarrativeChange('a b', 'ab'), null);
    const long = describeNarrativeChange('开头。', `开头。${'很长的一句话'.repeat(20)}`);
    assert.match(long.added, /…（共 \d+ 字）$/);
});

test('正文没变：原样返回；placement 属于别的正文：拒绝', () => {
    const { placements } = planAt(NARRATIVE, [1]);
    const same = rebaseScenePlacements(placements, NARRATIVE, NARRATIVE);
    assert.equal(same.rebased, false);
    assert.deepEqual(same.placements, placements);
    assert.throws(
        () => rebaseScenePlacements([{ ...placements[0], sourceHash: 'other' }], NARRATIVE, `${NARRATIVE}\n${PLACEHOLDER}`),
        error => error.code === 'SCENE_SOURCE_CHANGED',
    );
});

test('尾插（tail）放在尾部状态栏占位符之前', () => {
    const text = `${NARRATIVE}\n\n${PLACEHOLDER}`;
    assert.equal(findNarrativeTailOffset(text), NARRATIVE.length + 2);
    assert.equal(findNarrativeTailOffset(NARRATIVE), NARRATIVE.length);
    const result = insertScenePlacementsPreservingSlots(text, [{ placement: { mode: 'tail' }, content: '[image:t]' }], { block: true });
    assert.equal(result, `${NARRATIVE}\n\n[image:t]\n${PLACEHOLDER}`);
});

test('已有旧槽位时映射后仍保留旧槽位', () => {
    const withOld = NARRATIVE.replace('脚印。', '脚印。\n[image:old1]');
    // 与 normalizeMessageSceneSourceText 一致：只去掉槽位记号本身
    const stripped = withOld.replace('[image:old1]', '');
    const source = createSceneSource(stripped, { filterRules: DEFAULT_MESSAGE_FILTER_RULES });
    const placements = [{ mode: 'source', offset: source.points[2].offset, sourceHash: source.sourceHash }];
    const changedStripped = `${stripped}\n\n${PLACEHOLDER}`;
    const rebased = rebaseScenePlacements(placements, stripped, changedStripped);
    const result = insert(`${withOld}\n\n${PLACEHOLDER}`, rebased.placements, ['new1']);
    assert.ok(result.includes('[image:old1]'));
    assert.ok(result.includes('她低声说。\n[image:new1]'));
    assert.ok(result.endsWith(PLACEHOLDER));
});

test('设置迁移：老用户自定义规则补上 v10 新规则一次，空列表保持走默认', () => {
    assert.deepEqual(appendMissingFilterRules([]), { rules: [], added: 0 });
    const custom = [{ start: '<think>', end: '</think>' }, { start: '<StatusPlaceHolderImpl/>', end: '<statusplaceholderimpl/>' }];
    const first = appendMissingFilterRules(custom);
    assert.equal(first.added, MESSAGE_FILTER_RULES_ADDED_IN_V10.length - 1);
    assert.deepEqual(first.rules.slice(0, 2), custom);
    const second = appendMissingFilterRules(first.rules);
    assert.equal(second.added, 0);
    assert.deepEqual(second.rules, first.rules);
});
