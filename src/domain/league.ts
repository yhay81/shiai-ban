export type LeagueTeam = {
  displayName: string;
  id: string;
};

export type LeagueMatch = {
  awayId: string;
  confirmedScore: string;
  homeId: string;
};

export type ScheduledMatch = {
  awayId: string;
  homeId: string;
  pitchNumber: number;
  slotNumber: number;
};

export type Standing = LeagueTeam & {
  draws: number;
  goalDifference: number;
  goalsAgainst: number;
  goalsFor: number;
  losses: number;
  played: number;
  points: number;
  wins: number;
};

export const parseScore = (value: string) => {
  const matched = /^(\d{1,2}):(\d{1,2})$/u.exec(value);
  if (!matched) return null;
  return { away: Number(matched[2]), home: Number(matched[1]) };
};

export const calculateStandings = (teams: LeagueTeam[], matches: LeagueMatch[]): Standing[] => {
  const rows = new Map(
    teams.map((team) => [
      team.id,
      {
        ...team,
        draws: 0,
        goalDifference: 0,
        goalsAgainst: 0,
        goalsFor: 0,
        losses: 0,
        played: 0,
        points: 0,
        wins: 0,
      },
    ]),
  );

  for (const match of matches) {
    const score = parseScore(match.confirmedScore);
    const home = rows.get(match.homeId);
    const away = rows.get(match.awayId);
    if (!score || !home || !away) continue;
    home.played += 1;
    away.played += 1;
    home.goalsFor += score.home;
    home.goalsAgainst += score.away;
    away.goalsFor += score.away;
    away.goalsAgainst += score.home;
    if (score.home === score.away) {
      home.draws += 1;
      away.draws += 1;
      home.points += 1;
      away.points += 1;
    } else if (score.home > score.away) {
      home.wins += 1;
      away.losses += 1;
      home.points += 3;
    } else {
      away.wins += 1;
      home.losses += 1;
      away.points += 3;
    }
  }

  return [...rows.values()]
    .map((row) => ({ ...row, goalDifference: row.goalsFor - row.goalsAgainst }))
    .sort(
      (left, right) =>
        right.points - left.points ||
        right.goalDifference - left.goalDifference ||
        right.goalsFor - left.goalsFor ||
        left.displayName.localeCompare(right.displayName, "ja"),
    );
};

export const createRoundRobinSchedule = (
  teams: LeagueTeam[],
  pitchCount: number,
): ScheduledMatch[] => {
  if (teams.length < 3 || pitchCount < 1) return [];
  const rotating: Array<LeagueTeam | null> = [...teams];
  if (rotating.length % 2 === 1) rotating.push(null);
  const rounds = rotating.length - 1;
  const half = rotating.length / 2;
  const schedule: ScheduledMatch[] = [];
  let slotNumber = 1;

  for (let round = 0; round < rounds; round += 1) {
    const pairings: Array<[LeagueTeam, LeagueTeam]> = [];
    for (let index = 0; index < half; index += 1) {
      const left = rotating[index];
      const right = rotating[rotating.length - 1 - index];
      if (!left || !right) continue;
      const swap = (round + index) % 2 === 1;
      pairings.push(swap ? [right, left] : [left, right]);
    }
    for (let offset = 0; offset < pairings.length; offset += pitchCount) {
      pairings.slice(offset, offset + pitchCount).forEach(([home, away], index) => {
        schedule.push({
          awayId: away.id,
          homeId: home.id,
          pitchNumber: index + 1,
          slotNumber,
        });
      });
      slotNumber += 1;
    }
    const fixed = rotating[0];
    const tail = rotating.slice(1);
    tail.unshift(tail.pop() ?? null);
    rotating.splice(0, rotating.length, fixed, ...tail);
  }
  return schedule;
};
