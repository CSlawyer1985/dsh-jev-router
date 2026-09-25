/**
 * 共享常量：单独成文件，避免 settings.js 的顶层 await 影响纯逻辑导入。
 */

/** 默认 namespace。与 cordis.patch.yml 的 loader entry id 保持一致。 */
export const DEFAULT_NAMESPACE = 'jev-router';

/** 作者标识。 */
export const AUTHOR = 'chenshi.ai';

/** 作者主页。 */
export const AUTHOR_URL = 'https://chenshi.ai';
