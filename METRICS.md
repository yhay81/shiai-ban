# Metrics

`product_events` の許可済みイベントを、匿名セッションと日付で集計します。

- `visited`: 製品を開いた
- `tournament_created`: 会場盤を作成した
- `team_registered`: チーム札を受け取った
- `schedule_started`: 総当たり日程を公開した
- `score_reported`: チームが得点を申告した
- `result_confirmed`: 双方一致または主催確認で得点が確定した
- `tournament_completed`: 全試合が完了した
- `public_board_viewed`: 公開盤面を閲覧した
- `returned`: 再訪した

`x-shiai-qa: 1` のイベントは保存時に `is_qa = 1` とし、実利用集計から除外します。
大会データは開始21日後、イベントは45日後に定期削除します。
