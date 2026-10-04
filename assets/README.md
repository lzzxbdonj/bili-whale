# assets/

- `qrcode.min.js` —— [qrcodejs](https://github.com/davidshimjs/qrcodejs) 1.0.0，MIT License，作者 davidshimjs。
  用途：把 B 站扫码登录链接**内联**渲染成本地二维码页面（`lib/qrpage.js` 会把它整段嵌进生成的 HTML），
  这样登录页不联网、不依赖 CDN、也不把一次性的登录链接发给任何第三方服务。

升级方式：换掉 `qrcode.min.js` 即可（保持 UMD/全局 `QRCode` 暴露方式不变）。
