// NAI 提示词语法高亮：往返校验（高亮 HTML 去标签后必须与原文一字不差）+ 配色不改字宽 + 与 nai-gallery 同一套分词。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    highlightPromptHtml, promptIssues, stripHighlightHtml, PROMPT_HL_CSS, PROMPT_HL_PALETTE,
} from '../../modules/draw/shared/nai-prompt-highlight.js';
import { hlPrompt } from '../../modules/draw/shared/gallery-sync/vendor/prompt-highlight.js';
import { XB_ACCENT } from '../../modules/draw/shared/xb-theme.js';

const root = new URL('../../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');

function unescapeJsString(s) {
    return s.replace(/\\(['"\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
}

// 默认预设：从 novel-draw.js 源码里截出 positivePrefix / negativePrefix（它 import 酒馆模块，node 里不能直接 import）
const drawSrc = read('modules/draw/providers/novelai/novel-draw.js');
const presetStrings = [...drawSrc.matchAll(/(?:positivePrefix|negativePrefix):\s*'((?:[^'\\]|\\.)*)'/g)].map(m => unescapeJsString(m[1]));
// 设置页测试提示词默认值和 placeholder
const htmlSrc = read('modules/draw/providers/novelai/novel-draw.html');
const testTags = htmlSrc.match(/<textarea id="nd_test_tags"[^>]*>([^<]*)<\/textarea>/)[1];
// 林霏开测试提示词（markdown 代码块）
const linBlocks = [...read('docs/plans/test-prompts/lin-feikai.md').matchAll(/```\n([\s\S]*?)\n```/g)].map(m => m[1]);

const TRICKY = [
    '',
    '1.2::artist foo_(bar)::, -4::artist collaboration::',
    '{{best quality}}, [[bad hands]], {[{nested}]}',
    '(cel shading:1.6), (tag b:1.3）, （全角）',
    'look at each |1boy | girl',
    'tag::0.5::tag2::',
    '::stray, 1.2:oops, 5::unclosed',
    '((unbalanced, ]]extra}',
    '(x 127x) artist bibi-chan (x 127x), artist: moccha_(mochancc)',
    'a < b & c > d, "quoted", \'single\', <span class="x">',
    'line one,\nline two\n\n  indented\ttab',
    '3::3D::artist :ningen_mame,:meion, year 2025, 10::best quality, absurdres::,',
    'emoji-free 中文，逗号，和 （括号）',
];

test('默认预设 + 测试提示词 + 林霏开用例都截到了', () => {
    assert.ok(presetStrings.length >= 4, `presets: ${presetStrings.length}`);
    assert.equal(testTags, '1girl, smile, upper body, simple background');
    assert.equal(linBlocks.length, 2);
});

test('往返校验：去标签后与原文一字不差', () => {
    const cases = [...presetStrings, testTags, ...linBlocks, ...TRICKY];
    for (const text of cases) {
        assert.equal(stripHighlightHtml(highlightPromptHtml(text)), text, JSON.stringify(text));
    }
});

test('和 nai-gallery 的 hlPrompt 输出完全一致（同一份分词器）', () => {
    for (const text of [...presetStrings, ...linBlocks, ...TRICKY]) assert.equal(highlightPromptHtml(text), hlPrompt(text).html);
});

test('语法问题能认出来：多余 ::、括号没配对、全角括号、少冒号', () => {
    assert.deepEqual(promptIssues(linBlocks[0]), []);
    assert.deepEqual(promptIssues(testTags), []);
    const issues = promptIssues('::stray, 1.2:oops, ((unbalanced, （x）').join(' | ');
    assert.match(issues, /多余的 ::/);
    assert.match(issues, /括号没配对/);
    assert.match(issues, /全角括号/);
    assert.match(issues, /少打一个冒号/);
    assert.match(highlightPromptHtml('a]'), /class="hb herr"/);
});

test('权重块、强调层级、分隔符都有对应的 class', () => {
    const html = highlightPromptHtml('1.2::a::, {{b}}, [c] | artist d');
    for (const cls of ['hw', 'wb', 'hbr d1', 'hbr d2', 'hc', 'hp', 'hap', 'han']) assert.ok(html.includes(`class="${cls}"`), cls);
});

test('高亮样式只改颜色和背景，不改粗细 / 字号 / 字距；配色避开主题色', () => {
    const spanRules = PROMPT_HL_CSS.split('\n').filter(line => line.startsWith('.xbhl-pre .'));
    assert.ok(spanRules.length >= 12);
    for (const rule of spanRules) {
        assert.equal(/font-weight|font-size|letter-spacing|padding|margin|border(?!-radius)|font-style/.test(rule.replace('font: inherit; letter-spacing: inherit;', '')), false, rule);
    }
    const colors = Object.values(PROMPT_HL_PALETTE).map(c => c.toLowerCase());
    assert.equal(colors.includes(XB_ACCENT.toLowerCase()), false);
    assert.equal(/box-shadow:(?!\s*none)|outline:(?!\s*none)/.test(PROMPT_HL_CSS), false);
});
