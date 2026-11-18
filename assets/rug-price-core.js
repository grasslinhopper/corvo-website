/**
 * Corvo: the price of a rug, in one place.
 *
 * Both calculators use it: the rug page (assets/rug-configurator.js) and the price guide of "Tailor your rug"
 * (assets/rug-price-guide.js). A rug therefore costs the same wherever it is priced:
 *
 *   price per m² of the craft level × the multiplier of a premium material
 *   × (1 + the supplements, in percent) × area × VAT, rounded half-up to the euro, as the price list is
 *
 * Only whole numbers are multiplied, so no price turns on a rounding of the browser.
 */
(() => {
  if (window.CorvoRugPrice) {
    return;
  }

  /**
   * The supplement of the format: a small rug or an oversize rug, never both.
   *
   * rules: { small: { below (m²), percent }, large: { long (cm), short (cm), percent } }
   * area: the priced area in cm². long, short: the sides in cm.
   */
  function format(rules, area, long, short) {
    if (rules.small.percent > 0 && area < rules.small.below * 10000) {
      return { percent: rules.small.percent, reason: 'small' };
    }

    if (rules.large.percent > 0 && (long > rules.large.long || short > rules.large.short)) {
      return { percent: rules.large.percent, reason: 'large' };
    }

    return { percent: 0, reason: null };
  }

  /**
   * The price in whole euros, without VAT ("net") and with VAT ("gross").
   *
   * rate: cents per m², without VAT. times: the multiplier of the material in hundredths (100 is × 1).
   * percent: the supplements added up. units: the priced area in thousandths of a cm² (a circle is not a whole
   * number of cm²). vat: percent.
   */
  function euros({ rate, times = 100, percent = 0, units, vat = 0 }) {
    const base = BigInt(Math.round(rate)) * BigInt(Math.round(times)) * BigInt(Math.round(100 + percent)) * BigInt(Math.round(units));

    return {
      net: Number((base + 5000000000000n) / 10000000000000n),
      gross: Number((base * BigInt(Math.round(100 + vat)) + 500000000000000n) / 1000000000000000n)
    };
  }

  window.CorvoRugPrice = { format: format, euros: euros };
})();
