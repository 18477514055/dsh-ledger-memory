import fs from "node:fs";
const TEMP = process.env.TEMP;
const css = fs.readFileSync(TEMP + "/pl-css.css", "utf8");
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root{
  --dsw-alias-bg-base:#fff; --dsw-alias-bg-layer-1:#fff;
  --dsw-alias-bg-module-platform:#f2f3f5;
  --dsw-alias-label-primary:#0f1115; --dsw-alias-label-secondary:#55595f; --dsw-alias-label-tertiary:#8b9098;
  --dsw-alias-border-l1:#e6e7ea; --dsw-alias-border-l2:#dcdee2; --dsw-alias-border-l3:#c9ccd2;
  --dsw-alias-brand-primary:#3964fe;
}
body{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:24px;background:#fff;color:#0f1115}
${css}
</style></head><body>
<div class="pl-settings" style="max-width:760px">
  <div class="pl-settings__tabs" role="tablist">
    <button class="pl-settings__tab pl-settings__tab--on" role="tab">常规<span class="pl-settings__tab-badge">6</span></button>
    <button class="pl-settings__tab" role="tab">注入<span class="pl-settings__tab-badge">4</span></button>
    <button class="pl-settings__tab" role="tab">扩展记忆<span class="pl-settings__tab-badge">0</span></button>
    <button class="pl-settings__tab" role="tab">高级<span class="pl-settings__tab-badge">32</span></button>
  </div>
  <div class="pl-settings__scroll">
    <div class="pl-settings__card">
      <div class="pl-settings__card-head"><span class="pl-settings__card-title">常规</span><span class="pl-settings__card-hint">日常真正会调的那几项。</span></div>
      <div class="pl-settings__card-body">
        <div class="pl-settings__row">
          <div class="pl-settings__main">
            <div class="pl-settings__label-line"><span class="pl-settings__label">全量压缩触发水位</span></div>
            <div class="pl-settings__hint"><span class="pl-settings__hint-text">水位到多少时压一次。</span></div>
          </div>
          <div class="pl-settings__ctl">
            <div class="pl-settings__ctl-wrap pl-settings__ctl-wrap--num">
              <input class="pl-settings__range-input" type="range" min="30" max="79" step="1" value="70">
              <div class="pl-settings__num-box"><input class="pl-settings__num" type="number" value="70"><span class="pl-settings__unit">%</span></div>
            </div>
          </div>
        </div>
        <div class="pl-settings__row">
          <div class="pl-settings__main">
            <div class="pl-settings__label-line"><span class="pl-settings__label">允许插件自动压缩</span></div>
            <div class="pl-settings__hint"><span class="pl-settings__hint-text">关掉就只在你说的时候压。</span></div>
          </div>
          <div class="pl-settings__ctl">
            <label class="pl-settings__switch pl-settings__switch--on">
              <input type="checkbox" checked>
              <span class="pl-settings__switch-track" aria-hidden="true"><span class="pl-settings__switch-knob"></span></span>
            </label>
          </div>
        </div>
        <div class="pl-settings__row">
          <div class="pl-settings__main">
            <div class="pl-settings__label-line"><span class="pl-settings__label">活跃台账行数上限</span></div>
            <div class="pl-settings__hint"><span class="pl-settings__hint-text">超过就要先归档。</span></div>
          </div>
          <div class="pl-settings__ctl">
            <div class="pl-settings__ctl-wrap pl-settings__ctl-wrap--num">
              <input class="pl-settings__range-input" type="range" min="50" max="400" step="1" value="400">
              <div class="pl-settings__num-box"><input class="pl-settings__num" type="number" value="400"><span class="pl-settings__unit">行</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</body></html>`;
fs.writeFileSync(TEMP + "/pl-panel.html", html, "utf8");
console.log("已生成:", TEMP + "\\pl-panel.html", html.length, "字符");
