'use strict';
// Ported from src/utils/grid.ts so bot grids match the app & in-game exactly.
const GRID_DIAMETER = 146.25;

function getCorrectedMapSize(mapSize) {
  const remainder = mapSize % GRID_DIAMETER;
  const offset = GRID_DIAMETER - remainder;
  return remainder < 120 ? mapSize - remainder : mapSize + offset;
}

function numberToLetters(num) {
  const mod = num % 26;
  let pow = (num / 26) | 0;
  const out = mod ? String.fromCharCode(64 + mod) : (pow--, 'Z');
  return pow ? numberToLetters(pow) + out : out;
}

function getGridCoordinate(rawX, rawY, mapSize) {
  const corrected = getCorrectedMapSize(mapSize);
  if (corrected <= 0) return '??';
  const divisions = Math.floor(corrected / GRID_DIAMETER);
  const clampedX = Math.max(0, Math.min(corrected - 0.001, rawX));
  const clampedY = Math.max(0, Math.min(corrected - 0.001, rawY));
  const colIndex = Math.floor(clampedX / GRID_DIAMETER);
  const colLabel = numberToLetters(colIndex + 1);
  const rowFromSouth = Math.floor(clampedY / GRID_DIAMETER);
  const rowIndex = Math.max(0, divisions - 1 - rowFromSouth);
  return `${colLabel}${rowIndex}`;
}

module.exports = { getGridCoordinate };
