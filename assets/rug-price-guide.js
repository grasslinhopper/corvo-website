/**
 * Corvo addition: the price guide of the "Tailor your rug" page.
 *
 * The page lists the craft levels, the materials, the size rules and the options with their prices as plain text
 * (sections/rug-price-guide.liquid). This element only adds them up as the visitor chooses, the way a rug page does:
 *
 *   price per m² of the craft level, without VAT
 *   × the multiplier of a premium material
 *   × (1 + the supplements: material, high pile, carving, round corners, small or large format)
 *   × area × VAT, rounded half-up to the euro
 *   + the price of each custom colour
 *   × the priority supplement when the faster shipping is chosen
 *
 * The result is a guide, not a price to pay: nothing is added to the cart. It is copied into the proposal form of the
 * page (sections/proposal-form.liquid), so the request that reaches the shop says what the visitor saw.
 *
 * A design of the design library is carried here by the address of the page ("?design=" and the handle of the design):
 * it is shown in the first step, its craft level is chosen when the design has one, and its name is sent with the
 * request.
 */
(() => {
  if (window.customElements.get('rug-price-guide')) {
    return;
  }

  const scratch = document.createElement('template');

  /**
   * Prints an amount in cents with one of Shopify's money formats ("€{{amount_with_comma_separator}}")
   */
  function formatMoney(cents, format) {
    const pattern = /\{\{\s*(\w+)\s*\}\}/,
      match = format.match(pattern);

    const delimit = (precision, thousands, decimal) => {
      const [whole, fraction] = (cents / 100).toFixed(precision).split('.'),
        grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);

      return fraction ? grouped + decimal + fraction : grouped;
    };

    const styles = {
      amount: () => delimit(2, ',', '.'),
      amount_no_decimals: () => delimit(0, ',', '.'),
      amount_with_comma_separator: () => delimit(2, '.', ','),
      amount_no_decimals_with_comma_separator: () => delimit(0, '.', ','),
      amount_with_apostrophe_separator: () => delimit(2, "'", '.'),
      amount_no_decimals_with_space_separator: () => delimit(0, ' ', ','),
      amount_with_space_separator: () => delimit(2, ' ', ','),
      amount_with_period_and_space_separator: () => delimit(2, ' ', '.')
    };

    if (!match) {
      return delimit(2, ',', '.');
    }

    // The format may hold HTML entities: read it back as plain text
    scratch.innerHTML = format.replace(pattern, (styles[match[1]] || styles.amount)());

    return scratch.content.textContent;
  }

  /**
   * A whole number typed in a field, or NaN
   */
  function wholeNumber(value) {
    const text = String(value).trim();

    return /^\d+$/.test(text) ? parseInt(text, 10) : NaN;
  }

  /**
   * Centimetres as feet and inches: 300 reads 9′10″
   */
  function feetAndInches(centimetres) {
    const inches = Math.round(centimetres / 2.54);

    return `${Math.floor(inches / 12)}′${inches % 12}″`;
  }

  class RugPriceGuide extends HTMLElement {
    connectedCallback() {
      const source = this.querySelector('[data-guide-config]');

      if (!source) {
        return;
      }

      this.config = JSON.parse(source.textContent);
      this.widthInput = this.querySelector('[data-guide-width]');
      this.lengthInput = this.querySelector('[data-guide-length]');
      this.coloursInput = this.querySelector('[data-guide-colours]');
      this.form = document.getElementById(this.getAttribute('form'));
      this.designBox = this.querySelector('[data-guide-design]');
      this.designPrompt = this.querySelector('[data-guide-design-prompt]');
      this.design = null;

      this.addEventListener('input', () => this.update());
      this.addEventListener('change', () => this.update());
      this.addEventListener('click', (event) => this.onClick(event));

      this.chooseDesign(new URLSearchParams(window.location.search).get('design'));
      this.update();
      this.watchBar();
    }

    /**
     * A design of the design library is carried into the guide, or taken out of it
     */
    chooseDesign(handle) {
      const { strings } = this.config;

      this.design = (handle && (this.config.designs || []).find((design) => design.handle === handle)) || null;

      if (this.designPrompt) {
        this.designPrompt.hidden = this.design !== null;
      }

      if (!this.designBox) {
        return;
      }

      this.designBox.hidden = this.design === null;

      if (!this.design) {
        return;
      }

      const { name, style, image } = this.design,
        level = this.config.levels.find((candidate) => String(candidate.number) === String(this.design.level)),
        picture = this.designBox.querySelector('[data-guide-design-image]'),
        write = (selector, text) => {
          const element = this.designBox.querySelector(selector);

          if (element) {
            element.textContent = text;
          }
        };

      if (picture) {
        picture.hidden = !image;

        if (image) {
          picture.src = image;
          picture.alt = style ? strings.designAlt.replace('[name]', name).replace('[style]', style.toLowerCase()) : name;
        }
      }

      write('[data-guide-design-name]', name);
      write('[data-guide-design-style]', [style, strings.designLibrary].filter(Boolean).join(' · '));
      write('[data-guide-design-note]', (level ? strings.designLevel.replace('[label]', level.label) : strings.designUnknown).replace('[name]', name));

      // A design whose craft level is known sets the level of the guide
      if (level) {
        const choice = this.querySelector(`[data-guide-level][value="${level.number}"]`);

        if (choice) {
          choice.checked = true;
        }
      }
    }

    /**
     * On a narrow screen a bar keeps the figure in view while the steps are on the screen and the summary is not
     */
    watchBar() {
      const bar = this.querySelector('[data-guide-bar]'),
        steps = this.querySelector('.price-guide__steps'),
        summary = this.querySelector('[data-guide-summary]');

      if (!bar || !steps || !summary || !('IntersectionObserver' in window)) {
        return;
      }

      const onScreen = new Map(),
        observer = new IntersectionObserver((entries) => {
          entries.forEach((entry) => onScreen.set(entry.target, entry.isIntersecting));
          bar.hidden = !(onScreen.get(steps) && !onScreen.get(summary));
        });

      observer.observe(steps);
      observer.observe(summary);
    }

    onClick(event) {
      if (event.target.closest('[data-guide-design-remove]')) {
        const url = new URL(window.location.href);

        url.searchParams.delete('design');
        window.history.replaceState(window.history.state, '', url);

        this.chooseDesign(null);
        this.update();

        return;
      }

      const size = event.target.closest('[data-guide-size]');

      if (size) {
        this.widthInput.value = size.dataset.width;
        this.lengthInput.value = size.dataset.length;
        this.update();

        return;
      }

      if (this.coloursInput && event.target.closest('[data-guide-colours-less], [data-guide-colours-more]')) {
        const current = wholeNumber(this.coloursInput.value) || 0,
          next = event.target.closest('[data-guide-colours-more]') ? current + 1 : current - 1;

        this.coloursInput.value = Math.min(Math.max(next, 0), 99);
        this.update();
      }
    }

    /**
     * What the visitor has chosen
     */
    read() {
      const { config } = this,
        { limits, strings } = config,
        levelNumber = this.querySelector('[data-guide-level]:checked')?.value,
        materialHandle = this.querySelector('[data-guide-material]:checked')?.value,
        width = wholeNumber(this.widthInput.value),
        length = wholeNumber(this.lengthInput.value),
        colours = this.coloursInput ? wholeNumber(this.coloursInput.value) : 0;

      const state = {
        level: config.levels.find((level) => String(level.number) === String(levelNumber)) || config.levels[0],
        material: config.materials.find((material) => material.handle === materialHandle) || config.materials[0],
        width: width,
        length: length,
        options: Array.from(this.querySelectorAll('[data-guide-option]:checked'), (option) => option.dataset.guideOption),
        colours: colours > 0 ? colours : 0,
        express: this.querySelector('[data-guide-shipping]:checked')?.value === 'express',
        design: this.design,
        errors: []
      };

      if (!(width > 0) || !(length > 0)) {
        state.errors.push(strings.errorNumber);
      } else {
        if (Math.min(width, length) < limits.min) {
          state.errors.push(strings.errorMin);
        }

        if (Math.max(width, length) > limits.long) {
          state.errors.push(strings.errorLong);
        }

        if (Math.min(width, length) > limits.short) {
          state.errors.push(strings.errorShort);
        }

        state.area = Math.round(width * length / 100) / 100;
      }

      return state;
    }

    /**
     * The guide for a valid state, in cents of the shop's currency
     */
    amounts(state) {
      const { config } = this,
        longSide = Math.max(state.width, state.length),
        shortSide = Math.min(state.width, state.length),
        squareCentimetres = state.width * state.length;

      let percent = state.material.percent,
        reason = null;

      ['pile', 'carving', 'corners'].forEach((option) => {
        if (state.options.includes(option)) {
          percent += config[option];
        }
      });

      if (config.small.percent > 0 && squareCentimetres < config.small.below * 10000) {
        percent += config.small.percent;
        reason = 'small';
      } else if (config.large.percent > 0 && (longSide > config.large.long || shortSide > config.large.short)) {
        percent += config.large.percent;
        reason = 'large';
      }

      // The rate is in cents per m², without VAT; the material multiplier and the supplements are in hundredths.
      // Each result is rounded half-up to the euro, as the price list is.
      const base = BigInt(state.level.rate) * BigInt(state.material.times) * BigInt(Math.round(100 + percent)) * BigInt(squareCentimetres),
        netEuros = Number((base + 5000000000n) / 10000000000n),
        grossEuros = Number((base * BigInt(Math.round(100 + config.vat)) + 500000000000n) / 1000000000000n),
        express = (cents) => state.express ? Math.round(cents * (100 + config.expressPercent) / 100) : cents,
        gross = express(grossEuros * 100 + state.colours * config.colour),
        net = express(netEuros * 100 + state.colours * config.colourNet);

      return { gross: gross, net: net, perSquareMetre: Math.round(gross / (squareCentimetres / 10000)), reason: reason };
    }

    /**
     * An amount of the shop's currency as the visitor reads it. In another currency it is approximate, so it is
     * rounded to a whole unit; the page says once, under the total, that the figures are converted.
     */
    money(cents) {
      const { config } = this;

      if (config.fx === 1) {
        return formatMoney(cents, config.moneyFormat);
      }

      return formatMoney(Math.round(cents * config.fx / 100) * 100, config.moneyFormat);
    }

    update() {
      const { strings } = this.config,
        state = this.read(),
        valid = state.errors.length === 0,
        result = valid ? this.amounts(state) : null,
        set = (selector, text) => {
          const element = this.querySelector(selector);

          if (element) {
            element.textContent = text;
          }
        };

      // The size step
      const error = this.querySelector('[data-guide-size-error]'),
        info = this.querySelector('[data-guide-size-info]'),
        note = this.querySelector('[data-guide-size-note]');

      error.hidden = valid;
      error.textContent = valid ? '' : state.errors[0];
      info.hidden = !valid;
      this.widthInput.setAttribute('aria-invalid', String(!valid));
      this.lengthInput.setAttribute('aria-invalid', String(!valid));

      if (valid) {
        info.textContent = `${strings.area.replace('[area]', state.area)} · ${strings.about.replace('[size]', `${feetAndInches(state.width)} × ${feetAndInches(state.length)}`)}`;
      }

      note.hidden = !(valid && result.reason);
      note.textContent = valid && result.reason ? strings[result.reason] : '';

      this.querySelectorAll('[data-guide-size]').forEach((button) => {
        const same = (Number(button.dataset.width) === state.width && Number(button.dataset.length) === state.length)
          || (Number(button.dataset.width) === state.length && Number(button.dataset.length) === state.width);

        button.setAttribute('aria-pressed', String(same));
      });

      // The summary, line by line
      const optionNames = state.options.map((option) => strings[option]),
        materialText = state.material.percent > 0 || state.material.times !== 100 ? `${state.material.name} (${state.material.note})` : state.material.name,
        sizeText = valid ? `${state.width} × ${state.length} cm · ${strings.area.replace('[area]', state.area)}${result.reason ? ` · ${strings[result.reason]}` : ''}` : '—',
        shippingText = state.express ? strings.express : strings.standard;

      if (state.colours > 0) {
        optionNames.push(`${strings.summaryColours.toLowerCase()}: ${strings.colours.replace('[count]', state.colours)}`);
      }

      const optionsText = optionNames.length > 0 ? optionNames.join(', ').replace(/^./, (letter) => letter.toUpperCase()) : strings.none,
        shippingShort = shippingText.replace(strings.shippingWord, '').trim().replace(/^./, (letter) => letter.toUpperCase()),
        levelText = strings.craftLevel.replace('[label]', state.level.label),
        designName = state.design ? strings.designFrom.replace('[name]', state.design.name) : '',
        designText = state.design ? `${designName} · ${levelText}` : levelText;

      set('[data-guide-summary-design]', designText);
      set('[data-guide-summary-material]', materialText);
      set('[data-guide-summary-size]', sizeText);
      set('[data-guide-summary-options]', optionsText);
      set('[data-guide-summary-shipping]', shippingShort);
      set('[data-guide-total]', valid ? this.money(result.gross) : '—');
      set('[data-guide-bar-total]', valid ? this.money(result.gross) : '—');
      set('[data-guide-net]', valid ? this.money(result.net) : '—');
      set('[data-guide-per-m2]', valid ? this.money(result.perSquareMetre) : '—');

      const message = this.querySelector('[data-guide-message]');

      if (message) {
        message.hidden = valid;
        message.textContent = valid ? '' : strings.invalid;
      }

      // The guide travels with the request. Without a valid size there is no guide to send, but a design carried
      // from the design library is still named.
      if (this.form) {
        const field = this.form.querySelector('[data-guide-field]'),
          recap = this.form.querySelector('[data-guide-recap]'),
          lines = valid ? [
            `${strings.summaryDesign}: ${designText}`,
            `${strings.summaryMaterial}: ${materialText}`,
            `${strings.summarySize}: ${sizeText}`,
            `${strings.summaryOptions}: ${optionsText}`,
            `${strings.summaryShipping}: ${shippingShort}`,
            `${strings.summaryTotal}: ${strings.recapTotal.replace('[total]', this.money(result.gross)).replace('[net]', this.money(result.net))}`
          ] : (state.design ? [`${strings.summaryDesign}: ${designName}`] : []);

        // The team works in the shop's currency: a guide read in another currency also travels in the shop's own
        if (valid && this.config.fx !== 1) {
          lines.push(strings.recapBase.replace('[currency]', this.config.shopCurrency).replace('[total]', (result.gross / 100).toFixed(2)).replace('[net]', (result.net / 100).toFixed(2)));
        }

        // The line is sent only when there is something to send
        if (field) {
          field.value = lines.join(' | ');

          if (lines.length > 0) {
            field.name = field.dataset.name;
          } else {
            field.removeAttribute('name');
          }
        }

        if (recap) {
          recap.hidden = lines.length === 0;
          recap.querySelector('[data-guide-recap-text]').textContent = lines.join(' · ');
        }
      }

      this.state = state;
      this.result = result;
    }
  }

  window.customElements.define('rug-price-guide', RugPriceGuide);
})();
