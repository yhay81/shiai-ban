WITH funnel AS (
  SELECT
    COUNT(DISTINCT CASE WHEN name = 'visited' THEN session_id END) AS users,
    COUNT(DISTINCT CASE WHEN name = 'tournament_created' THEN session_id END) AS creators,
    COUNT(DISTINCT CASE WHEN name = 'team_registered' THEN session_id END) AS teams,
    COUNT(DISTINCT CASE WHEN name = 'schedule_started' THEN tournament_id END) AS started,
    COUNT(DISTINCT CASE WHEN name = 'score_reported' THEN session_id END) AS reporters,
    COUNT(DISTINCT CASE WHEN name = 'result_confirmed' THEN tournament_id END) AS with_results,
    COUNT(DISTINCT CASE WHEN name = 'tournament_completed' THEN tournament_id END) AS completed,
    COUNT(DISTINCT CASE WHEN name = 'public_board_viewed' THEN session_id END) AS board_viewers,
    COUNT(DISTINCT CASE WHEN name = 'returned' THEN session_id END) AS returned,
    COUNT(DISTINCT CASE WHEN name = 'tournament_created' AND created_at >= unixepoch() - 604800 THEN tournament_id END) AS created_7d,
    COUNT(DISTINCT CASE WHEN name = 'team_registered' AND created_at >= unixepoch() - 604800 THEN session_id END) AS teams_7d
  FROM product_events
  WHERE is_qa = 0
),
live AS (
  SELECT
    COUNT(CASE WHEN status = 'registration' THEN 1 END) AS registration_open,
    COUNT(CASE WHEN status = 'active' THEN 1 END) AS active,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed_live
  FROM tournaments
  WHERE expires_at > unixepoch()
),
participants AS (
  SELECT COUNT(CASE WHEN dropped = 0 THEN 1 END) AS registered_teams FROM players
)
SELECT * FROM funnel CROSS JOIN live CROSS JOIN participants;
