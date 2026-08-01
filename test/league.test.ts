import { calculateStandings, createRoundRobinSchedule } from "../src/domain/league";

const teams = ["A", "B", "C", "D", "E"].map((displayName) => ({ displayName, id: displayName }));

describe("round-robin schedule", () => {
  it("creates every pairing exactly once for an even team count", () => {
    const schedule = createRoundRobinSchedule(teams.slice(0, 4), 2);
    const pairs = schedule.map((match) => [match.homeId, match.awayId].sort().join(":"));
    expect(schedule).toHaveLength(6);
    expect(new Set(pairs)).toHaveProperty("size", 6);
    expect(Math.max(...schedule.map((match) => match.slotNumber))).toBe(3);
  });

  it("handles a bye without creating a phantom match", () => {
    const schedule = createRoundRobinSchedule(teams, 2);
    const appearances = new Map<string, number>();
    schedule.forEach((match) => {
      appearances.set(match.homeId, (appearances.get(match.homeId) ?? 0) + 1);
      appearances.set(match.awayId, (appearances.get(match.awayId) ?? 0) + 1);
    });
    expect(schedule).toHaveLength(10);
    expect([...appearances.values()]).toEqual([4, 4, 4, 4, 4]);
  });

  it("never schedules the same team twice in one slot", () => {
    const schedule = createRoundRobinSchedule(teams, 3);
    const slots = new Map<number, string[]>();
    schedule.forEach((match) => {
      slots.set(match.slotNumber, [
        ...(slots.get(match.slotNumber) ?? []),
        match.homeId,
        match.awayId,
      ]);
    });
    for (const ids of slots.values()) expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("standings", () => {
  it("ranks by points, goal difference, then goals scored", () => {
    const standings = calculateStandings(teams.slice(0, 3), [
      { awayId: "B", confirmedScore: "2:0", homeId: "A" },
      { awayId: "C", confirmedScore: "1:1", homeId: "A" },
      { awayId: "C", confirmedScore: "0:3", homeId: "B" },
    ]);
    expect(standings.map((row) => row.id)).toEqual(["C", "A", "B"]);
    expect(standings[0]).toMatchObject({ goalDifference: 3, points: 4, played: 2 });
    expect(standings[1]).toMatchObject({ goalsFor: 3, points: 4 });
  });
});
