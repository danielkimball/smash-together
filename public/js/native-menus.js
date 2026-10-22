// Original US menu rows. Navigation still uses the game's own controller input.
export const isGameplay = (scene) => [22, 52, 53, 54, 61].includes(scene);
export const characterScenes = [16, 17, 18, 19, 20];
export const menuRows = {
  8: {
    address: 0x801331b8,
    y: [53, 95, 132, 154],
    labels: ["1P Game", "Training", "Break the Targets", "Board the Platforms"],
  },
  9: {
    address: 0x80134948,
    y: [42, 82, 119, 159],
    labels: ["VS Start", "Rules", "Time / Stock", "VS Options"],
    adjust: [1, 2],
  },
  10: {
    address: 0x801348e0,
    y: [64, 89, 114, 140, 164],
    labels: [
      "Handicap",
      "Team Attack",
      "Stage Select",
      "Damage",
      "Item Switch",
    ],
    adjust: [0, 1, 2, 3],
  },
  11: {
    address: 0x801333d8,
    y: [51, ...Array.from({ length: 15 }, (_, i) => 66 + i * 10)],
    labels: ["Item Frequency"],
    adjust: "all",
  },
  57: {
    address: 0x801337b8,
    y: [55, 101, 149],
    labels: ["Sound", "Screen Adjust", "Backup Clear"],
    adjust: [0],
  },
  58: {
    address: 0x80133078,
    y: [53, 100, 147],
    labels: ["Characters", "VS Records", "Sound Test"],
  },
  59: {
    address: 0x80134308,
    y: [72, 120, 168],
    labels: ["Music", "Sound", "Voice"],
    adjust: "all",
  },
  47: { address: 0x801330c0, y: [60, 87, 114, 141, 168, 195], labels: [] },
};
