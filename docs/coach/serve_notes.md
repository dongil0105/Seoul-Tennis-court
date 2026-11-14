# Serve research notes (companion to serve_knowledge.json)

**How this was gathered.** Web search summaries only. Page fetch was blocked (pmc.ncbi.nlm.nih.gov and
www.frontiersin.org did not resolve) and the 200-search budget ran out, so no paper was read in full.
Every number is from a search snippet (S-id), from memory (`memory`) or from a small model I wrote (`computed`).
6 of 72 metrics are memory-only; 5 of 16 players have an unverified stance. Source ids below refer to the JSON.

## Reference bands worth building on (elite, 0 deg = straight joint)
- Front-knee flexion at trophy: **64.5 +/- 9.7 deg** pooled (S1); study means span 47-81.
- Elbow at trophy: study means **85-107 deg** (S1), i.e. the coaching "L shape".
- Trunk inclination at trophy: 25.0 +/- 7.1 deg (S1). Back arch: ~18 deg flat, ~25 deg kick (S19).
- Racket drop: shoulder external rotation 172 +/- 12 (S2) vs 130 +/- 27 pooled (S1) - not visible to MediaPipe anyway.
  By racket drop the front knee is already back to ~13 deg: legs extend BEFORE the racket drops (S2).
- Contact: arm-trunk angle **~101 deg** (S2), pooled 110.7 +/- 16.9 (S1); elbow flexion 30 +/- 16 pooled (S1);
  trunk 48 deg above horizontal = ~42 deg forward of vertical (S2).
- Contact height **1.49 x standing height** in both "aerial" and "terrestrial" servers (S6); 1.5x rule (S21).
- Contact in front: **0.31-0.37 x height** (S6), about 55-65 cm for 175 cm; ~0.8 m ahead of the left toe in
  Olympic players (S14, label unclear).
- Toss release to contact: 0.6-1.24 s in 36 pros (S52); toss height does not predict contact height (S54).
- Jump: only ~11-14 cm on second serves, and jump height did not predict ball speed (S56).
- App hint (derived, memory): with no racket tracking, the elite hitting WRIST at contact sits at about
  1.2-1.25 x standing height (impact height minus ~0.45-0.5 m of racket).

## Serve types
- Elite lab numbers (S11): flat 187 km/h / ~1,217 rpm; slice 167 / ~2,216; kick 147 / ~3,213.
  Spin axis differs by only ~11-14 deg between types: a kick is mostly "more spin".
- Kick vs flat contact: 0.20-0.25 m further left, 0.15-0.20 m closer to the baseline, same height ~2.74 m (S16);
  racquet 8.7 cm more posterior and 21.1 cm more medial (S12); flat is ~17 cm further forward (S17).
- Second serve: racket speed unchanged, ball speed -24% (S13). Sampras second serve >4,500 rpm (S51).
- Toss cues (flat 12-1 o'clock forward-right, slice further right, kick over/behind the head) are coaching
  conventions (S71); the 11-12 o'clock kick cue is from memory.

## Platform vs pinpoint
- Classic data (S5): pinpoint 2.1 vs platform 1.5 BW vertical force, contact 2.65 vs 2.54 m, 173 vs 166 km/h;
  platform has more forward force (0.20 vs 0.16 BW) and travel (60 vs 46 cm).
- 72% of the 50 best ATP servers use foot-up, more so the taller they are (S7).
- For club players: platform is the safer default (balance, no back-foot timing, fewer foot faults).
- Verified: Federer, Djokovic, Sampras platform; Isner, Zverev (hybrid), Medvedev, Alcaraz, Serena,
  Swiatek ("lateral pinpoint"), Keys (switched to pinpoint in 2025) pinpoint.
- Sinner timeline: platform (juniors) -> pinpoint mid-2018 -> platform June 2021 -> pinpoint from late 2023
  -> new rhythm and toss (not stance) after the 2025 US Open (S25-S30).
- **Unverified**: Fritz (platform, memory), Rybakina and Sabalenka (pinpoint, memory), Gauff (pinpoint, one
  analyst remark), Osaka (mixed; 2016 analysis only). Heights are from memory except Sinner, Isner, Gauff.

## Speeds
- ATP top-10 average 188.6 / 154.1 km/h (first / second); WTA top-10 164.0 / 135.7 km/h (S45).
- 2025 ATP leader Mpetshi Perricard 216.3 km/h average first serve; Zverev 207.3 (S44).
- Recreational: only one measured point found - NTRP 4.0 fastest flat ~137 km/h, slice 105-113 km/h (S50).
  NTRP 3.0 / 3.5 / 4.5 ranges in the JSON are memory estimates.

## Physics
- Straight-line serve needs a 2.61 m contact (geometry; S23 says 2.6 m): a 1.74 m player at 1.5x height.
- At 144 km/h, 2.7 m contact doubles the success chance of 2.2 m (Brody via S20).
- 600 rpm topspin: +29% window at 120 mph, +41% more serves in at 150 mph (S21).
- My model (`computed`, not published): from 2.4 m, the flat-serve window is ~5 deg at 80 km/h, 3 deg at 100,
  1.9 deg at 120; a 200 km/h flat serve from 2.7 m has ~0.9 deg. At club speeds the ball must leave about
  level or slightly upward.

## Where sources disagree
- Shoulder external rotation: 172 (S2) vs 130 (S1) - angle definitions differ.
- Elbow at contact: ~20 (Fleisig, memory) vs 30 pooled (S1) vs study means up to 44.
- Knee bend: no bend clearly hurts at every level (S9), but 75 vs 56 deg gained only ~3 km/h (S8) and Kovacs
  says "bend deeper" is a poor cue (S82). Reward timing, not depth.
- Stance and speed: +7 km/h for pinpoint in 1983 data (S5) vs no clear difference later (S10, S6).
- Which stance is more common, and which suits serve-and-volley (S59 vs S5): contradictory.
- Toss too far back: Essential Tennis says long (S63), Human Kinetics says net (S67). Show the video.
- Sinner's pinpoint switch: 2023 (ATP, US Open, Cahill, Roddick) vs late 2025 (SI).
- Abbreviated take-back: often called simpler, but coaches say it is harder for club players (S69, S70).

## Gaps to close before shipping
- Hip-shoulder separation, shoulder tilt at trophy, back-knee flexion, lateral trunk tilt at contact: no
  published serve values were retrieved (JSON has memory placeholders).
- Per-serve-type contact coordinates are in S18's tables; Fleisig's full table is in S2 - neither could be opened.
- Measured recreational kinematics and speeds by level barely exist in what I could reach.
- Fault thresholds in `skeleton_sign` are suggested flags derived from the elite bands, not validated cut-offs.
