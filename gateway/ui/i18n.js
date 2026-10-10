/**
 * 译表本体搬到了 core/src/i18n/dict.ts，经 core.js 打进来；这里只把它挂回 window.SATU_I18N，
 * prefs.js 的 t() / errText() 照旧查这个名字。
 *
 * app.js 是普通脚本（不是 module），所以这里挂全局，且必须在 prefs.js 之前、core.js 之后引入。
 */
window.SATU_I18N = SatuCore.dict
