// 增补提示词（原「测试提示词」）：全局一份，不跟参数预设走。开着时加到每一次出图：
// 正向接在场景 tag 之后，负向接在负向固定之后。已经包含同样内容的不重复加（编辑重生成时读回的旧提示词）。
import { joinTags } from './character-prompts.js';

export function normalizeSupplementPrompt(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        enabled: source.enabled === true,
        prompt: String(source.prompt || '').trim(),
        uc: String(source.uc || '').trim(),
    };
}

export function applySupplementPrompt(scene, negativePrompt, supplement) {
    const baseScene = String(scene || '');
    const baseNegative = String(negativePrompt || '');
    const supp = normalizeSupplementPrompt(supplement);
    if (!supp.enabled) return { scene: baseScene, negativePrompt: baseNegative };
    return {
        scene: supp.prompt && !baseScene.includes(supp.prompt) ? joinTags(baseScene, supp.prompt) : baseScene,
        negativePrompt: supp.uc && !baseNegative.includes(supp.uc) ? joinTags(baseNegative, supp.uc) : baseNegative,
    };
}
