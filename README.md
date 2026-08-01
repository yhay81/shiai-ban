# 試合盤

少年サッカー、フットサル、学校行事などの一日リーグで、チーム受付、総当たり日程、
双方の得点確認、順位までを一つの会場盤に閉じる道具です。

- 選手名や連絡先を集めず、チーム名だけを扱います。
- アカウントは不要です。主催鍵とチーム札を各端末に保存します。
- ピッチ数と試合時間から総当たり日程を自動配置します。
- JSON / CSV の控えと印刷用の盤面を保存できます。
- Cloudflare Workers、Hono JSX、Vite+、D1 で動作します。

## 開発

```powershell
npm install
npm run check
npm test
npm run build
```

詳しいデータ境界は `PRIVACY.md`、安全上の連絡先は `SECURITY.md` を参照してください。
