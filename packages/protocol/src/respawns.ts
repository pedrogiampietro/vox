export type RespawnCatalogItem = {
  code: string;
  name: string;
};

export type RespawnCatalogGroup = {
  title: string;
  items: RespawnCatalogItem[];
};

const RAW_RESPAWNS = `
Any city / Ab'Dendriel:
1 - Boosted Creature
1a - Outer Crypt
1b - Unhallowed Crypt
1c - Inner Crypt

Ankrahmun / Oskayaat:
2 - Cobra Bastion
3 - Cobra Underground
4 - Otherworld (GT Ank)
5 - Oskayaat Undercity (After Tp) -2
6 - Oskayaat Undercity (Weretiger) -1
7 - Murky Caverns (Werecrocodile)
8 - Nightmare Isles
9 - Mother of Scarab Lair

Carlin:
11 - Demona Warlocks
12 - Forest Furies Camp
13 - Library Biting Books
14 - Energy Library
15 - Fire Library
16 - Ice Library
17 - Ice Library (Alternative)

Cormaya / Gnomprona:
18 - Crystal Enigma
18a - Crystal Enigma South
18b - Crystal Enigma North
19 - Ingol Surface
20 - Ingol -1
21 - Ingol -2
22 - Ingol -3
23 - Monster Graveyard - East
24 - Monster Graveyard - West
25 - Sparkling Pools (East)
26 - Sparkling Pools (West)
27 - Ingol -4

Darashia:
28 - Apocalypse (Jugger Seal)
28a - Apocalypse (Jugger Seal) After TP
29 - Bazir (Phantasm)
30 - Ferumbras Castle
31 - Ferumbras Entrance
32 - Hell Hub (Ferumbras Entrance -1)
33 - Dragon Lair
34 - Gloom Pillars
35 - Grim Reaper Halls
36 - Putrefactory
37 - Deep Desert (Skeleton Elite)
38 - Werelion Sanctum -2 West
39 - Werelion Sanctum -1
40 - Werehyaena Lairs South
41 - Werehyaena Lairs North
43 - Necromancer (Drefia)
44 - Burster Spectre Tomb
45 - Elder Wyrms
46 - Lions Rock
47 - Darklight Core
48 - Jaded Roots
49 - Ashfalor (Undead Seal)
49a - Ashfalor (Undead Seal) After TP
50 - Verminor (Plague Seal)
50a - Verminor (Plague Seal -1)
51 - Pumin -1 e -2
51a - Pumin -3
52 - Infernatil (Fire Seal)
52a - Infernatil (Fire Seal) +1
53 - Tafariel (Dt Seal)
54 - Tafariel (Dt Seal -1)

Edron:
55 - Ancient Lion Knight
57 - Bounacean Lion (Crypt Warrior)
58 - Wyvern Hill
59 - Cyclopolis
60 - Demons New (Demon Forge)
61 - The Vats (Defilers)
62 - Edron Forgotten Tomb (Undeads east)
63 - Edron Mages Tower (Servants)
64 - Forest of Life (Carnisylvans -1)
64a - Forest of Life (Carnisylvans)
65 - Hero Fortress -2
66 - Hero Fortress -3
67 - Vampires Crypt
68 - Zugurosh
69 - The Blood Halls (Dts)
70 - Azzilon Castelo Lower (Térreo e +1)
71 - Azzilon Castelo Upper (+2 e +3)
72 - Azzilon Catacombs -1
73 - Azzilon Catacombs -2
74 - Azzilon Catacombs -3 e -4
75a - Book World -1
75b - Book World -2
75c - Book World -3
76 - Crumbling Caverns

Farmine:
78 - Yielothax
79 - Brimstone Bug Cave
80 - Corruption Hole (Old)
81 - Corrupted Gardens (Brimstone Surface)
84 - Falcon Bastion
85 - Falcon Head (Oberon Area)
86 - Falcon Underground (Before Oberon)
87 - Ghastly Dragon Lair
88 - Ghastly Dragons Palace
89 - Lizard City
90 - Draken Abominations (Scale)
91 - Draken Walls South
92 - Draken Walls North
93 - Drakens & Undead Dragons
94 - Stampor Cave
95 - Temple Complex (Mutated Tigers)
96 - Spirittrails (Souleaters)
97 - Otherworld (GT Zao)
98 - Nimmersatts Breeding Ground (Mega Dragon)
99 - Nimmersatts Breeding Ground +1
100 - Keepers Lair (Brimstone Bug)

Feyrist / Candia:
101 - Chocolate Mines -1
102 - Chocolate Mines -2
103 - Desert Dungeons -1
104 - Desert Dungeons -2
105 - Summer Courts (Labyrinth)
106 - Summer Courts (Crazed Summers)
107 - Weakened Mountain
108 - Weakened Cave -2
109 - Weakened Cave -1

Gray Island:
110 - Deathlings
111 - Deeplings
113 - The Hive Tower
114 - The Hive Underground

Issavi / Rascacoon / Krailos:
115 - Exotic Cave -1
116 - Exotic Cave -2
117 - Goanna West-South (Southern Steppe)
118 - Goanna East (Urmahlullu)
119 - Goanna West-North (Central Steppe)
120 - Krailos Nightmare
121 - Krailos Brimstone Bug
122 - Kilmaresh Puzzle (Cultists)
123 - Kilmaresh Catacombs (Sphinx)
124 - Issavi Ogres
125 - Issavi Sewers (Cultists)
126 - Salt Caves (Bashmu)
127 - Pirat Mines
128 - The Wreckoning (Pirat)
129 - Ruins of Nuur (Girtablilu)

Isle of Ada:
129a - Stag bastion
129b - Isle of Ada Outskirts
129c - Isle of Ada Mines
129d - Bloodfire Gorge

Kazordoon:
130 - Ravenous Lava Lurker
131 - Diremaw (Growth Task area)
132 - Warzone 1
133 - Warzone 2
134 - Warzone 3
135 - Warzone 4
136 - Warzone 5
137 - Warzone 6
138 - Warzone 7
139 - Warzone 8
140 - Warzone 9
142 - Middle Spike (lvl 50-79)
143 - Lower Spike (80+)

Liberty Bay / Goroma:
144 - Gargoyle Sanctuary (Meriana)
145 - Mountain Wyrms
148 - Calassa
149 - Behemoths
150 - Hellgorge (Demons)
152 - Hive Outpost
153 - Bonelord Dungeons
154 - Quara Caves (Quara Scout)
155 - Medusa Cave
156 - Wyrm Lairs (Depot East)

Podzila:
157 - Podzilla Bottom -4
158 - Podzilla Bottom -3
159 - Podzilla Stalk (-1 e -2)

Port Hope / Marapur:
161 - Carnivora Rocks -1 e -2
162 - Carnivora Rocks -3
163 - Medusa Tower
164 - Iksupan (Pututu)
165 - Iksupan Last Stand (Trap Area)
166 - Iksupan Undercity (Atab Area)
167 - Asura Palace
168 - Asura Mirror
169 - Asura Vaults (True Asura -1)
169a - Asura Vaults (True Asura -2)
170 - Nagas (-1 e -2)
171 - Great Pearl Fan Reef (Foam and Turtles) -1
172 - Great Pearl Fan Reef (Foam and Turtles) -2
174 - Behemoth Forbidden Land
175 - Banuta Main Floor
177 - Banuta -2
178 - Banuta -3
179 - Banuta -4
181 - Water Elemental Old
183 - Hydras Forbidden Land
185 - Gazer Spectre Temple
186 - Netherworld (Flimsy)

Roshamuul:
187 - Guzzlemaw Valley (East)
188 - Guzzlemaw Valley (West)
189 - Upper Roshamuul (South)
190 - Upper Roshamuul (North East)
191 - Lower Roshamuul
192 - Roshamuul Prison -3
193 - Roshamuul Prison -2
194 - Roshamuul Prison -1
195 - Roshamuul (DP - North East)
196 - Roshamuul (DP - South)

Svargrond:
197 - Sea Serpent Old Cave (Parcels)
198 - Sea Serpent New
199 - Ice Witch Temple
200 - Svargrond Mines (Yakchal Floor)
201 - Otherworld (GT Svargrond)
202 - Winter Court (Castle)
203 - Winter Court (Dream Labyrinth)

Thais:
204 - Minotaur Cults
205 - Minotaur Cults -1
206 - MoTA Extension (Fury)

Venore:
207 - Amazon Camp
208 - Gloom Wolves (Poacher Lair)
209 - Orc Fortress
210 - Swamp Troll Den
211 - Brain Grounds -1 e -2
212 - Brain Grounds -3
213 - Ripper Spectre Cellar
214 - Buried Cathedral (First floor)
215 - Buried Cathedral (Last floor)
216 - Dragon Lords (POI)
217 - Tafariel + Infernatil (Dts)
218 - Verminor (Defilers)
219a - Bulltaur Lair -1
219b - Bulltaur Lair -2

Vengoth:
220 - Furious Crater
221 - Ebb and Flow (North)
222 - Ebb and Flow (South)
223 - Rotten Wasteland (South)
224 - Rotten Wasteland (North)
225 - Werewolf Cave
226 - Vengoth Castle
228 - Claustrophobic Inferno
229 - Mirrored Nightmare
400 - Bloody Tusks
401 - Norcferatu Dungeons
401a - Norcferatu Dungeons (Center)
401b - Norcferatu Dungeons (West)
401c - Norcferatu Dungeons (East)
402 - Norcferatu Fortress

Yalahar:
231 - Alchemist Bog Raiders
232 - Alchemist Mutated Humans
234 - Cemetery Grim Reapers
235 - Cemetery Nightmares
237 - Magician Cults
241 - Magician Demons West
244 - War Golems (New East)
246 - Sunken Quaras
249 - Fenrock Dragon Lord
250 - Foreigner Elfs
252 - Foreigner Dragon
253 - Foreigner Pirate

Oramond:
254 - Minos Entrance
256 - West Oramond (Quaras+)
258 - Glooth Tower
259 - Abandoned Sewers (Demons)
260 - Seacrest Grounds
261 - Fungi Sewers
262 - Mountain Hideout (Furys)
262a - Mountain Hideout -1 (Undead Dragon)
263 - Catacombs West
264 - Catacombs East
265 - Catacombs Middle
266 - Active Raid (300 votes)
268 - Glooth Factory (War Golem)
269 - Glooth Bandits West
270 - Glooth Bandits East
271 - Glooth Bandits South
`;

function normalizeRespawn(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseRespawns(raw: string): RespawnCatalogGroup[] {
  const groups: RespawnCatalogGroup[] = [];
  let current: RespawnCatalogGroup | null = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const group = line.match(/^(.+):$/);
    const title = group?.[1];
    if (title) {
      current = { title, items: [] };
      groups.push(current);
      continue;
    }

    const item = line.match(/^([0-9]+[a-z]?)\s+-\s+(.+)$/i);
    const code = item?.[1];
    const name = item?.[2];
    if (code && name && current) current.items.push({ code, name });
  }

  return groups;
}

export const RESPAWN_CATALOG = parseRespawns(RAW_RESPAWNS);

export const RESPAWN_NAMES = RESPAWN_CATALOG.flatMap((group) => group.items.map((item) => item.name));

const RESPAWN_BY_KEY = new Map(RESPAWN_NAMES.map((name) => [normalizeRespawn(name), name]));

export function canonicalRespawnName(value: string): string | null {
  return RESPAWN_BY_KEY.get(normalizeRespawn(value)) ?? null;
}
