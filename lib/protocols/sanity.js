'use strict'

// Sanity bounds applied to every parsed reading regardless of protocol,
// before it's published. These exist because a checksum-valid frame can
// still be *misparsed*: jk.js's FIELD_OFFSET in particular is a value
// verified against one specific piece of hardware, and other JK firmware/
// board generations are documented (see diag/findings/PROTOCOL_NOTES.md)
// to use a different offset. A wrong offset still produces a frame that
// passes its checksum (the checksum only covers frame integrity, not
// field meaning) but reads pack voltage/current/SOC from the wrong bytes.
// The result is a plausible-looking number, not an obvious garbage value
// or a crash, so it would otherwise reach SignalK (and a boat's
// instruments) silently. Rejecting readings outside physically-sane
// battery ranges turns that silent-corruption failure mode into a
// visible "device not supported" error instead.
const SOC_RANGE = [0, 100]
const PACK_VOLTAGE_RANGE = [0.5, 1000] // single cell to a large series pack
const CURRENT_RANGE = [-2000, 2000] // amps; generous headroom over any BMS this size

function implausibleReadingReason (reading) {
  const { soc, packVoltage, current } = reading
  if (soc != null && (soc < SOC_RANGE[0] || soc > SOC_RANGE[1])) {
    return `soc=${soc} outside ${SOC_RANGE[0]}-${SOC_RANGE[1]}%`
  }
  if (packVoltage != null && (packVoltage < PACK_VOLTAGE_RANGE[0] || packVoltage > PACK_VOLTAGE_RANGE[1])) {
    return `packVoltage=${packVoltage} outside ${PACK_VOLTAGE_RANGE[0]}-${PACK_VOLTAGE_RANGE[1]}V`
  }
  if (current != null && (current < CURRENT_RANGE[0] || current > CURRENT_RANGE[1])) {
    return `current=${current} outside ${CURRENT_RANGE[0]}-${CURRENT_RANGE[1]}A`
  }
  return null
}

module.exports = { implausibleReadingReason }
