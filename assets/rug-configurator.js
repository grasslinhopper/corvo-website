/**
 * Corvo: the rug configurator (see snippets/rug-steps.liquid).
 *
 * It works the price of a rug out in the browser, from the material, the pile height, the shape, the size, the
 * colours and the shipping chosen, and keeps the product form pointing at the variant that carries that price:
 *
 *  - a listed size, in a listed shape, in the material and the pile height its price was set for, with standard
 *    shipping and no priced extra, is the rug's own variant;
 *  - anything else is a variant of the hidden price-step product, looked up through the Storefront API.
 *
 * Which of these a client may choose is decided by the customisation level of the rug: the page prints only the
 * steps that level allows, and this script works with whatever steps are there.
 *
 * A rug may have one other choice besides its size, a colourway, a frame or a material: the rug's own variant is then
 * the one of the chosen size in that colourway or material. A round standard size is one of the rug's own variants;
 * its area is the area of the circle. An oval is priced on the rectangle it fits in.
 *
 * The formula itself is shared with the price guide of "Tailor your rug": see assets/rug-price-core.js.
 *
 * Nothing here reloads the page. The theme's <product-form> still adds to the cart: this element only decides what.
 */
(() => {
  if (window.customElements.get('rug-configurator')) {
    return;
  }

  const API_URL = '/api/2026-10/graphql.json';

  const STEP_QUERY = `query RugPriceStep($handle: String!, $option: String!, $reference: String!, $country: CountryCode) @inContext(country: $country) {
    product(handle: $handle) {
      variantBySelectedOptions(selectedOptions: [{name: $option, value: $reference}]) {
        id
        availableForSale
        price { amount currencyCode }
      }
    }
  }`;

  // The price steps already looked up, shared by every configurator of the page ("handle|step|country" > promise)
  const lookups = new Map();

  const scratch = document.createElement('template');

  /**
   * Formats an amount in cents with a Shopify money format, such as "€{{amount_with_comma_separator}}"
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

  function feetAndInches(centimetres) {
    const inches = Math.round(centimetres / 2.54);

    return `${Math.floor(inches / 12)}′${inches % 12}″`;
  }

  function wholeNumber(value) {
    return /^\d+$/.test(value) ? parseInt(value, 10) : NaN;
  }

  /**
   * A choice written after its own heading: "Shipping in 3 weeks" under "Shipping" reads "In 3 weeks"
   */
  function afterHeading(label, heading) {
    if (heading && label.toLowerCase().startsWith(`${heading.toLowerCase()} `)) {
      const rest = label.slice(heading.length + 1);

      return rest.charAt(0).toUpperCase() + rest.slice(1);
    }

    return label;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
      node.className = className;
    }

    if (text !== undefined) {
      node.textContent = text;
    }

    return node;
  }

  class RugConfigurator extends HTMLElement {
    connectedCallback() {
      const source = this.querySelector('script[data-rug-config]');

      if (!source) {
        return;
      }

      this.config = JSON.parse(source.textContent);
      this.controller = new AbortController();
      this.colours = this.config.colours.map((colour) => ({ original: colour.ref, choice: null }));
      this.choice = this.config.choice ? Math.max(0, this.config.choice.selected) : null;
      this.shape = this.config.round === true ? 'round' : 'rect';
      this.width = this.config.selected.w;
      this.length = this.config.selected.l;
      this.material = this.config.materials ? Math.max(0, this.config.materials.selected) : null;
      this.pile = this.config.pile ? 0 : null;
      this.applyChoice();
      this.applyCard();
      this.version = 0;
      this.status = 'idle';
      this.openIndex = null;
      this.forceErrors = false;
      this.wantsSubmit = false;

      const options = { signal: this.controller.signal };

      this.addEventListener('input', this.onInput.bind(this), options);
      this.addEventListener('change', this.onChange.bind(this), options);
      this.addEventListener('focusout', this.onFocusOut.bind(this), options);
      this.addEventListener('click', this.onClick.bind(this), options);
      this.addEventListener('keydown', this.onKeyDown.bind(this), options);

      this.colours.forEach((colour, index) => this.renderColour(index));
      this.syncSize();

      // The order buttons are printed after this element: wait until the page has settled before wiring the form
      window.setTimeout(() => {
        if (!this.isConnected || !this.controller) {
          return;
        }

        this.form?.addEventListener('submit', this.onSubmit.bind(this), { capture: true, signal: this.controller.signal });
        this.update({ immediate: true });
      }, 0);
    }

    disconnectedCallback() {
      this.controller?.abort();
      this.controller = null;
      window.clearTimeout(this.timer);
    }

    get form() {
      return document.forms[this.getAttribute('form')];
    }

    get widthInput() {
      return this.querySelector('[data-rug-width]');
    }

    get lengthInput() {
      return this.querySelector('[data-rug-length]');
    }

    get submitButtons() {
      return Array.from(this.form?.elements || []).filter((item) => item.type === 'submit');
    }

    /**
     * The material the rug is being priced in, when the rug has materials to choose from
     */
    get materialValue() {
      return this.material === null ? null : this.config.materials.values[this.material] || null;
    }

    /**
     * A material may carry its own colour card. Without one, the colours come from the Open Palette.
     */
    get hasCard() {
      return (this.materialValue?.palette || []).length > 0;
    }

    get palette() {
      return this.hasCard ? this.materialValue.palette : this.config.palette;
    }

    get pileHeight() {
      return this.pile === null ? null : this.config.pile.options[this.pile];
    }

    pilePercent(index) {
      const { pile } = this.config;

      return pile && pile.options[index] > pile.limit ? pile.percent : 0;
    }

    /* ----------------------------------------------------------------------------------------------------------------
     * EVENTS
     * ------------------------------------------------------------------------------------------------------------- */

    onInput(event) {
      const target = event.target;

      if (target.matches('[data-rug-width], [data-rug-length]')) {
        const digits = target.value.replace(/\D/g, '');

        if (digits !== target.value) {
          target.value = digits;
        }

        // Without a choice of shape, a size that is typed in is a rectangle
        if (!this.config.shapes) {
          this.shape = 'rect';
        }

        this.readSize();
        this.forceErrors = false;
        this.update();
      } else if (target.matches('[data-rug-colour-custom]') && this.openIndex !== null) {
        const text = target.value.trim();

        this.setColour(this.openIndex, text === '' ? null : { type: 'custom', text: text }, { keepOpen: true });
      }
    }

    onChange(event) {
      if (event.target.matches('[data-rug-shipping]')) {
        this.update({ immediate: true });
      }
    }

    onFocusOut(event) {
      // Leaving a size field: the message about a wrong size may now show
      if (event.target.matches('[data-rug-width], [data-rug-length]')) {
        window.setTimeout(() => this.isConnected && this.update({ immediate: true }), 0);
      }
    }

    onClick(event) {
      const size = event.target.closest('[data-rug-size]');

      if (size) {
        if ('round' in size.dataset) {
          this.shape = 'round';
        } else if (this.shape === 'round') {
          this.shape = 'rect';
        }

        this.width = parseInt(size.dataset.width, 10);
        this.length = parseInt(size.dataset.length, 10);
        this.forceErrors = false;
        this.syncSize();
        this.update({ immediate: true });

        return;
      }

      const shape = event.target.closest('[data-rug-shape]');

      if (shape) {
        this.setShape(shape.dataset.rugShape);

        return;
      }

      const material = event.target.closest('[data-rug-material]');

      if (material) {
        this.setMaterial(parseInt(material.dataset.rugMaterial, 10));

        return;
      }

      const pile = event.target.closest('[data-rug-pile]');

      if (pile) {
        this.pile = parseInt(pile.dataset.rugPile, 10);
        this.update({ immediate: true });

        return;
      }

      const option = event.target.closest('[data-rug-choice]');

      if (option) {
        this.setChoice(parseInt(option.dataset.rugChoice, 10));

        return;
      }

      const change = event.target.closest('[data-rug-colour-change]');

      if (change) {
        const index = parseInt(change.closest('[data-rug-colour]').dataset.rugColour, 10);

        if (this.openIndex === index) {
          this.closePalette();
        } else {
          this.openPalette(index);
        }

        return;
      }

      const chip = event.target.closest('[data-rug-chip]');

      if (chip && this.openIndex !== null) {
        this.setColour(this.openIndex, { type: 'palette', code: chip.dataset.code, name: chip.dataset.name || '', hex: chip.dataset.hex || '' });

        return;
      }

      if (event.target.closest('[data-rug-colour-reset]') && this.openIndex !== null) {
        this.setColour(this.openIndex, null);

        return;
      }

      if (event.target.closest('[data-rug-colour-done]')) {
        this.closePalette({ focus: true });
      }
    }

    onKeyDown(event) {
      if (event.key === 'Escape' && this.openIndex !== null) {
        event.stopPropagation();
        this.closePalette({ focus: true });
      } else if (event.key === 'Enter' && event.target.matches('[data-rug-width], [data-rug-length], [data-rug-colour-custom]')) {
        // "Enter" in a field confirms it: it must not submit anything
        event.preventDefault();
        event.target.blur();
      }
    }

    /**
     * Runs before the theme adds to the cart, and holds the order back until the right variant is known
     */
    onSubmit(event) {
      if (this.status === 'ready') {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      if (this.status === 'invalid') {
        this.forceErrors = true;
        this.render(this.state);
        this.widthInput?.focus();

        return;
      }

      if (this.status === 'quote') {
        return;
      }

      // The price step is being looked up, or the look-up failed: finish it first, then add to the cart
      this.wantsSubmit = true;
      this.submitter = event.submitter || null;
      this.setBusy(true);

      if (this.status === 'failed') {
        this.update({ immediate: true });
      }
    }

    /* ----------------------------------------------------------------------------------------------------------------
     * SIZE AND SHAPE
     * ------------------------------------------------------------------------------------------------------------- */

    /**
     * The size is kept here, not in the fields: a rug whose level allows no size of its own has no fields at all
     */
    readSize() {
      const width = this.widthInput,
        length = this.lengthInput;

      if (!width || !length) {
        return;
      }

      this.width = wholeNumber(width.value);
      this.length = this.shape === 'round' ? this.width : wholeNumber(length.value);
    }

    /**
     * Brings the size fields and the size buttons in line with the size and the shape. With a choice of shape, a
     * round rug has one field, its diameter, and the buttons are the listed sizes of that shape.
     */
    syncSize() {
      const { shapes, strings } = this.config,
        width = this.widthInput,
        length = this.lengthInput,
        diameterOnly = !!shapes && this.shape === 'round';

      if (width && length) {
        width.value = this.width > 0 ? this.width : '';
        length.value = this.length > 0 ? this.length : '';

        this.querySelectorAll('[data-rug-length-part]').forEach((part) => (part.hidden = diameterOnly));

        const label = this.querySelector('[data-rug-width-label]');

        if (label) {
          label.textContent = diameterOnly ? strings.diameter : strings.width;
        }
      }

      if (shapes) {
        this.querySelectorAll('[data-rug-size]').forEach((size) => (size.hidden = ('round' in size.dataset) !== (this.shape === 'round')));
      }
    }

    setShape(shape) {
      if (!this.config.shapes?.includes(shape) || shape === this.shape) {
        return;
      }

      this.shape = shape;

      if (shape === 'round') {
        // A round rug has one measure, its diameter: it starts from the shorter side or, when the rug lists round
        // sizes, from the listed one nearest to it
        const side = Math.min(this.width > 0 ? this.width : Infinity, this.length > 0 ? this.length : Infinity),
          listed = this.config.sizes.filter((size) => size.round && (this.choice === null || size.c === this.choice)).map((size) => size.w),
          nearest = listed.reduce((best, diameter) => (best === null || Math.abs(diameter - side) < Math.abs(best - side) ? diameter : best), null);

        this.width = nearest !== null ? nearest : (Number.isFinite(side) ? side : NaN);
        this.length = this.width;
      }

      this.forceErrors = false;
      this.syncSize();
      this.update({ immediate: true });
    }

    /* ----------------------------------------------------------------------------------------------------------------
     * MATERIAL
     * ------------------------------------------------------------------------------------------------------------- */

    setMaterial(index) {
      const { materials } = this.config,
        value = materials?.values[index];

      if (!value || value.premium || index === this.material) {
        return;
      }

      this.material = index;
      this.closePalette();
      this.applyCard();
      this.colours.forEach((colour, position) => this.renderColour(position));

      if (materials.source === 'option') {
        // The material is a choice of the rug itself: its variant and its pictures follow
        this.setChoice(index);
      } else {
        this.update({ immediate: true });
      }
    }

    /**
     * On a rug made in a choice of materials, the material sets the colours it can be made in: its own colour card
     * or, when it has none, the Open Palette. A colour the rug has no reference for in that material (it has none at
     * all, or the material is not the one it is shown in) starts on a colour of that list, and a colour picked on
     * another list is replaced the same way. Custom colours stay.
     */
    applyCard() {
      const card = this.config.materials && this.palette.length > 0 ? this.palette : null,
        shownIn = this.material === null || this.material === 0;

      this.colours.forEach((colour, index) => {
        const choice = colour.choice;

        colour.fromCard = card !== null && !(shownIn && colour.original !== '');

        if (choice?.type === 'custom') {
          return;
        }

        if (choice?.type === 'palette' && this.palette.some((entry) => entry.code === choice.code)) {
          return;
        }

        colour.choice = colour.fromCard ? Object.assign({ type: 'palette' }, card[index % card.length]) : null;
      });
    }

    /**
     * The sample button of the page orders a sample of what is being chosen: the material, the pile height and the
     * colours are written into its form, so they travel with the sample (see snippets/rug-sample-form.liquid)
     */
    syncSample() {
      const scope = this.closest('.shopify-section') || document,
        { strings, materials } = this.config,
        entries = [];

      if (materials?.step && this.materialValue) {
        entries.push([strings.propertyMaterial, this.materialValue.name]);
      }

      if (this.pile !== null) {
        entries.push([strings.propertyPile, strings.millimetres.replace('[height]', this.pileHeight)]);
      }

      if (this.colours.some((colour) => colour.choice !== null)) {
        entries.push([strings.propertyColours, this.colours.map((colour) => this.describeColour(colour, false)).join(', ')]);
      }

      scope.querySelectorAll('form[data-rug-sample-live]').forEach((form) => {
        const holder = form.querySelector('[data-rug-sample-choices]');

        if (!holder) {
          return;
        }

        // The colours the page wrote for the rug as shown give way to the colours chosen here
        form.querySelectorAll('[data-rug-sample-colours]').forEach((input) => (input.disabled = entries.some(([name]) => name === strings.propertyColours)));

        holder.replaceChildren(...entries.map(([name, value]) => {
          const input = element('input');

          input.type = 'hidden';
          input.name = `properties[${name}]`;
          input.value = value;

          return input;
        }));
      });
    }

    /* ----------------------------------------------------------------------------------------------------------------
     * THE OTHER CHOICE: A COLOURWAY, A FRAME OR A MATERIAL
     * ------------------------------------------------------------------------------------------------------------- */

    get choiceValue() {
      return this.choice === null ? null : this.config.choice.values[this.choice] || null;
    }

    /**
     * The colour references written at the end of a colourway, between brackets: "Sage (TL238/TL102)"
     */
    choiceReferences() {
      const match = /\(([^()]+)\)\s*$/.exec(this.choiceValue?.name || '');

      return match ? match[1].split('/').map((reference) => reference.trim()).filter(Boolean) : [];
    }

    /**
     * A colourway sets the colours the rug is shown in: they become the colours that can be changed
     */
    applyChoice() {
      if (!this.config.choice?.colour) {
        return;
      }

      const references = this.choiceReferences();

      this.colours.forEach((colour, index) => {
        if (references[index]) {
          colour.original = references[index];
        }
      });
    }

    setChoice(index) {
      if (this.choice === null || index === this.choice || !this.config.choice.values[index]) {
        return;
      }

      const previous = this.choiceValue;

      this.choice = index;
      this.applyChoice();
      this.colours.forEach((colour, position) => this.renderColour(position));

      this.querySelectorAll('[data-rug-choice]').forEach((button) => {
        button.setAttribute('aria-pressed', String(parseInt(button.dataset.rugChoice, 10) === index));
      });

      this.update({ immediate: true });

      // The pictures follow the choice, the way they follow the theme's own variant picker
      const media = this.choiceValue.media;

      if (media && this.form) {
        this.form.dispatchEvent(new CustomEvent('variant:change', {
          bubbles: true,
          detail: {
            formId: this.form.id,
            variant: { id: this.state?.variant || null, featured_media: { id: media, position: this.choiceValue.position } },
            previousVariant: previous?.media ? { featured_media: { id: previous.media, position: previous.position } } : null
          }
        }));
      }
    }

    /* ----------------------------------------------------------------------------------------------------------------
     * COLOURS
     * ------------------------------------------------------------------------------------------------------------- */

    paletteEntry(reference) {
      const number = (reference || '').replace(/^\D+/, '');

      return this.palette.find((entry) => entry.code === reference || (number !== '' && entry.code === number));
    }

    describeColour(colour, withOriginal = true) {
      const { strings } = this.config,
        choice = colour.choice;

      if (!choice) {
        return colour.original ? `${colour.original} · ${strings.asShown.toLowerCase()}` : strings.asShown;
      }

      let text = choice.type === 'custom' ? `${strings.custom}: ${choice.text}` : (choice.name ? `${choice.code} ${choice.name}` : choice.code);

      // A colour that comes from the card of the material replaces nothing: the rug has no colour of its own there
      if (withOriginal && colour.original && !colour.fromCard) {
        text += ` (${strings.replaces.replace('[reference]', colour.original)})`;
      }

      return text;
    }

    renderColour(index) {
      const row = this.querySelector(`[data-rug-colour="${index}"]`),
        colour = this.colours[index];

      if (!row) {
        return;
      }

      const swatch = row.querySelector('[data-rug-colour-swatch]'),
        hex = colour.choice ? (colour.choice.type === 'palette' ? colour.choice.hex : '') : (this.paletteEntry(colour.original)?.hex || '');

      row.querySelector('[data-rug-colour-value]').textContent = this.describeColour(colour);
      row.classList.toggle('is-changed', colour.choice !== null);

      if (hex) {
        swatch.style.setProperty('--swatch', hex);
      } else {
        swatch.style.removeProperty('--swatch');
      }

      swatch.classList.toggle('is-known', hex !== '');
      swatch.classList.toggle('is-custom', colour.choice?.type === 'custom');
    }

    setColour(index, choice, { keepOpen = false } = {}) {
      this.colours[index].choice = choice;
      // A colour that comes from the card of the material is never left empty: it goes back to a colour of the card
      this.applyCard();
      this.renderColour(index);

      if (keepOpen) {
        // Typing a custom colour: the palette stays open, and no chip is the chosen one any more
        this.querySelectorAll('[data-rug-chip]').forEach((chip) => chip.setAttribute('aria-pressed', 'false'));
      } else {
        this.closePalette({ focus: true });
      }

      this.update();
    }

    openPalette(index) {
      this.closePalette();

      const { strings, preview, customColour, baseCurrency } = this.config,
        palette = this.palette,
        // The colour card of a material is named after it; the Open Palette keeps its own name
        paletteTitle = this.hasCard ? strings.cardTitle.replace('[material]', this.materialValue.name) : strings.paletteTitle,
        row = this.querySelector(`[data-rug-colour="${index}"]`),
        colour = this.colours[index],
        panel = element('div', 'rug-palette'),
        fieldId = `rug-colour-${this.config.uid}-${index}`;

      panel.dataset.rugPalette = '';

      if (palette.length > 0) {
        const heading = element('p', 'rug-palette__title text-sm'),
          grid = element('div', 'rug-palette__grid');

        heading.append(element('span', '', paletteTitle));

        if (strings.paletteNote) {
          heading.append(element('span', 'text-subdued', strings.paletteNote));
        }

        grid.setAttribute('role', 'group');
        grid.setAttribute('aria-label', paletteTitle);

        palette.forEach((entry) => {
          const chip = element('button', 'rug-chip');

          chip.type = 'button';
          chip.dataset.rugChip = '';
          chip.dataset.code = entry.code;
          chip.dataset.name = entry.name;
          chip.dataset.hex = entry.hex;
          chip.setAttribute('aria-pressed', String(colour.choice?.type === 'palette' && colour.choice.code === entry.code));

          if (entry.hex) {
            const swatch = element('span', 'rug-chip__swatch');

            swatch.style.setProperty('--swatch', entry.hex);
            chip.append(swatch);
          }

          chip.append(element('span', 'rug-chip__code', entry.code));

          if (entry.name) {
            chip.append(element('span', 'rug-chip__name text-subdued', entry.name));
          }

          grid.append(chip);
        });

        panel.append(heading, grid);

        if (preview && !palette.some((entry) => entry.hex)) {
          panel.append(element('p', 'rug-step__preview text-sm', strings.palettePreview));
        }
      }

      if (strings.customTitle) {
        const field = element('label', 'rug-field rug-field--text'),
          label = element('span', 'rug-field__label text-sm'),
          input = element('input', 'rug-field__input');

        label.append(element('span', '', strings.customTitle));

        if (customColour > 0) {
          label.append(element('span', 'text-subdued', baseCurrency ? strings.perColour.replace('[amount]', strings.customPrice) : strings.supplementApplies));
        }

        field.htmlFor = fieldId;
        input.type = 'text';
        input.id = fieldId;
        input.maxLength = 80;
        input.autocomplete = 'off';
        input.placeholder = strings.customPlaceholder;
        input.dataset.rugColourCustom = '';
        input.value = colour.choice?.type === 'custom' ? colour.choice.text : '';

        field.append(label, input);
        panel.append(field);

        if (strings.customText) {
          panel.append(element('p', 'text-sm text-subdued', strings.customText));
        }
      }

      const actions = element('div', 'rug-palette__actions'),
        reset = element('button', 'link text-sm', strings.keep),
        done = element('button', 'link text-sm', strings.close);

      reset.type = 'button';
      reset.dataset.rugColourReset = '';
      done.type = 'button';
      done.dataset.rugColourDone = '';

      // "Keep the original" has no meaning for a colour that comes from the card of the material
      if (colour.fromCard) {
        actions.append(done);
      } else {
        actions.append(reset, done);
      }

      panel.append(actions);

      row.append(panel);
      row.querySelector('[data-rug-colour-change]').setAttribute('aria-expanded', 'true');
      this.openIndex = index;
    }

    closePalette({ focus = false } = {}) {
      if (this.openIndex === null) {
        return;
      }

      const button = this.querySelector(`[data-rug-colour="${this.openIndex}"] [data-rug-colour-change]`);

      this.querySelector('[data-rug-palette]')?.remove();
      this.openIndex = null;

      if (button) {
        button.setAttribute('aria-expanded', 'false');

        if (focus) {
          button.focus();
        }
      }
    }

    /* ----------------------------------------------------------------------------------------------------------------
     * THE PRICE
     * ------------------------------------------------------------------------------------------------------------- */

    /**
     * Rounds an amount in euros to the nearest step of the hidden price product. Null when it is above the last one.
     */
    nearestStep(euros) {
      const { min, bands } = this.config.steps;

      for (const [limit, size] of bands) {
        if (euros <= limit) {
          return Math.max(min, Math.round(euros / size) * size);
        }
      }

      return null;
    }

    /**
     * The price of a size. "own" is the rug's own variant (cents in the visitor's currency); "step" is a price step
     * (cents in the shop's currency); "quote" is a price above the last step.
     */
    /**
     * The listed size of the rug that this size is, if any: the same sides, the same shape and, when the rug has
     * another choice (a colourway, a frame, a material), the variant of that choice
     */
    standardSize(width, length) {
      const round = this.shape === 'round';

      return this.config.sizes.find((size) => (this.choice === null || size.c === this.choice) && size.round === round && ((size.w === width && size.l === length) || (size.w === length && size.l === width)));
    }

    amounts(width, length, express) {
      const { config } = this,
        shape = this.shape,
        round = shape === 'round',
        longSide = Math.max(width, length),
        shortSide = Math.min(width, length),
        // A round rug is priced on the area of its circle; an oval, on the rectangle it fits in
        squareCentimetres = round ? Math.round(Math.PI * width * width / 4) : width * length,
        // The same area in thousandths of a cm²: a circle is not a whole number of cm², and a price can turn on it
        areaUnits = round ? Math.round(Math.PI * width * width / 4 * 1000) : width * length * 1000,
        material = this.materialValue,
        // What each choice adds, in percent. A material the shop's list does not know has no percentage (null).
        parts = {
          rug: config.supplement,
          material: material ? (material.percent || 0) : 0,
          pile: this.pile === null ? 0 : this.pilePercent(this.pile),
          corners: shape === 'corners' ? config.corners : 0
        },
        format = window.CorvoRugPrice.format(config, squareCentimetres, longSide, shortSide),
        percent = parts.rug + parts.material + parts.pile + parts.corners + format.percent,
        // The rate is in cents per m², without VAT. The result is rounded half-up to the euro, as the price list is.
        euros = window.CorvoRugPrice.euros({ rate: config.rate, percent: percent, units: areaUnits, vat: config.vat }).gross,
        custom = this.colours.filter((colour) => colour.choice?.type === 'custom').length,
        list = euros * 100 + custom * config.customColour,
        total = express ? Math.round(list * (100 + config.expressPercent) / 100) : list,
        standard = this.standardSize(width, length),
        result = { euros: euros, percent: percent, reason: format.reason, custom: custom, parts: Object.assign(parts, { format: format.percent }) };

      // The rug's own variant carries the price of a listed size in a listed shape, in the material it belongs to
      // and at the pile height the rug is priced in. Any other choice has to be priced by the formula, or a Plus
      // material, a high pile or round corners would be charged at the price of the plain variant.
      const ownShape = shape === 'rect' || shape === 'round',
        ownMaterial = !config.materials || config.materials.source === 'option' || this.material === 0,
        ownPile = this.pile === null || parts.pile === this.pilePercent(0);

      if (standard && ownShape && ownMaterial && ownPile && !express && custom * config.customColour === 0) {
        return Object.assign(result, { mode: 'own', variant: standard.id, cents: standard.price });
      }

      // The formula cannot price a material it has no percentage for, and a premium material is not sold online
      if (material && (material.percent === null || material.premium)) {
        return Object.assign(result, { mode: 'quote', step: null, cents: null });
      }

      const step = this.nearestStep(total / 100);

      return Object.assign(result, { mode: step === null ? 'quote' : 'step', step: step, cents: step === null ? null : step * 100 });
    }

    calculate() {
      const { config } = this,
        { limits, strings } = config,
        round = this.shape === 'round',
        width = this.width,
        length = round ? this.width : this.length,
        express = this.querySelector('[data-rug-shipping]:checked')?.value === 'express',
        state = { width: width, length: length, shape: this.shape, round: round, express: express, errors: [], changed: this.colours.filter((colour) => colour.choice !== null).length };

      if (!(width > 0) || !(length > 0)) {
        state.errors.push(round ? strings.errorDiameter : strings.errorNumber);
      } else {
        // The limits are for sizes typed in: a listed size of the rug is always accepted
        if (!this.standardSize(width, length)) {
          if (Math.min(width, length) < limits.min) {
            state.errors.push(round ? strings.errorDiameterMin : strings.errorMin);
          }

          if (!round && Math.max(width, length) > limits.long) {
            state.errors.push(strings.errorLong);
          }

          if (Math.min(width, length) > limits.short) {
            state.errors.push(round ? strings.errorDiameterMax : strings.errorShort);
          }

          if (limits.step > 1 && (width % limits.step !== 0 || length % limits.step !== 0)) {
            state.errors.push(strings.errorStep);
          }
        }

        state.area = Math.round((state.round ? Math.PI * width * width / 4 : width * length) / 100) / 100;
      }

      if (state.errors.length > 0) {
        state.status = 'invalid';

        return state;
      }

      const amounts = this.amounts(width, length, express);

      Object.assign(state, amounts);
      state.status = amounts.mode === 'own' ? 'own' : (amounts.mode === 'quote' ? 'quote' : 'lookup');

      if (amounts.mode === 'step') {
        state.key = `${config.steps.handle}|${amounts.step}|${config.country}`;
      }

      // What the faster shipping adds, when both prices are in the shop's currency
      if (config.baseCurrency && config.expressPercent > 0) {
        const standard = express ? this.amounts(width, length, false) : amounts,
          faster = express ? amounts : this.amounts(width, length, true);

        state.expressExtra = standard.cents !== null && faster.cents !== null ? faster.cents - standard.cents : null;
      }

      return state;
    }

    /**
     * The line item properties that travel with the cart line
     */
    properties(state) {
      const { config } = this,
        { strings } = config,
        properties = {},
        changes = this.colours.map((colour, index) => (colour.choice ? [strings.propertyColour.replace('[number]', index + 1), this.describeColour(colour)] : null)).filter(Boolean);

      const material = config.materials?.step ? this.materialValue : null,
        pile = this.pile === null ? null : strings.millimetres.replace('[height]', this.pileHeight),
        parts = state.parts;

      if (state.mode === 'own') {
        // The rug's own variant already says its size and the choice it is a variant of. What it does not say is
        // written under the line: a material chosen from the rug's list, the pile height, the colours.
        if (material && config.materials.source === 'list') {
          properties[strings.propertyMaterial] = material.name;
        }

        if (pile) {
          properties[strings.propertyPile] = pile;
        }

        changes.forEach(([name, value]) => (properties[name] = value));

        return properties;
      }

      properties[strings.propertyDesign] = config.title;

      if (material) {
        properties[strings.propertyMaterial] = material.name;
      }

      if (pile) {
        properties[strings.propertyPile] = pile;
      }

      if (config.shapes) {
        properties[strings.propertyShape] = strings.shapeNames[state.shape];
      }

      properties[strings.propertySize] = `${state.round ? (config.shapes ? `Ø ${state.width} cm` : strings.round.replace('[size]', state.width)) : `${state.width} × ${state.length} cm`} (${state.area} m²)`;

      // The other choice of the rug, unless it is the material, already written above
      if (this.choiceValue && !(material && config.materials.source === 'option')) {
        properties[config.choice.name] = this.choiceValue.name;
      }

      if (changes.length > 0) {
        changes.forEach(([name, value]) => (properties[name] = value));
      } else if (this.colours.length > 0 && !config.choice?.colour) {
        properties[strings.propertyColours] = strings.asShown;
      }

      if (this.querySelector('[data-rug-shipping]')) {
        properties[strings.propertyShipping] = state.express ? `${afterHeading(strings.express, strings.propertyShipping)} (${strings.percent})` : afterHeading(strings.standard, strings.propertyShipping);
      }

      // Hidden from the buyer, kept for the team: where the line comes from and how its price was worked out
      properties._design = config.handle;
      properties._calculation = [
        `${state.shape} ${state.area} m2 x EUR ${config.rate / 100}/m2`,
        `supplements +${state.percent}% (rug ${parts.rug}, material ${parts.material}, pile ${parts.pile}, corners ${parts.corners}, format ${parts.format})`,
        `VAT ${config.vat}%`,
        `= EUR ${state.euros}`,
        `custom colours: ${state.custom}`,
        `priority: ${state.express ? `+${config.expressPercent}%` : 'no'}`,
        `price step: EUR ${state.step}`
      ].join(' | ');

      return properties;
    }

    /* ----------------------------------------------------------------------------------------------------------------
     * THE PAGE
     * ------------------------------------------------------------------------------------------------------------- */

    update({ immediate = false } = {}) {
      const version = ++this.version,
        state = this.calculate();

      this.state = state;
      window.clearTimeout(this.timer);
      this.render(state);

      if (state.status !== 'lookup') {
        this.settle(state);

        return;
      }

      // A price step: its variant has to be looked up. Typing waits a moment first, so not every keystroke asks.
      this.status = 'pending';
      this.timer = window.setTimeout(() => this.lookup(state, version), immediate || lookups.has(state.key) ? 0 : 250);
    }

    lookup(state, version) {
      const { config } = this;

      let promise = lookups.get(state.key);

      if (!promise) {
        promise = fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            query: STEP_QUERY,
            variables: { handle: config.steps.handle, option: config.steps.option, reference: String(state.step), country: config.country }
          })
        }).then((response) => response.json()).then((json) => {
          const variant = json?.data?.product?.variantBySelectedOptions;

          if (!variant || !variant.availableForSale) {
            throw new Error(`No price step ${state.step}`);
          }

          return { id: parseInt(variant.id.split('/').pop(), 10), cents: Math.round(parseFloat(variant.price.amount) * 100) };
        });

        lookups.set(state.key, promise);
        promise.catch(() => lookups.delete(state.key));
      }

      promise.then((variant) => {
        if (version !== this.version || !this.isConnected) {
          return;
        }

        state.variant = variant.id;
        state.cents = variant.cents;
        this.showPrice(state.cents);
        this.settle(state);
      }, () => {
        if (version !== this.version || !this.isConnected) {
          return;
        }

        this.status = 'failed';
        this.wantsSubmit = false;
        this.setBusy(false);
        this.showMessage(config.strings.failed);
      });
    }

    /**
     * The choice is final for now: either it can be ordered (the form gets its variant), or it cannot
     */
    settle(state) {
      const form = this.form,
        orderable = state.status === 'own' || state.status === 'lookup';

      this.status = orderable ? 'ready' : state.status;
      this.toggleAttribute('data-rug-busy', false);

      this.submitButtons.forEach((button) => {
        if (!orderable && !button.disabled) {
          button.disabled = true;
          button.dataset.rugBlocked = '';
        } else if (orderable && 'rugBlocked' in button.dataset) {
          button.disabled = false;
          delete button.dataset.rugBlocked;
        }
      });

      if (!orderable || !form) {
        this.wantsSubmit = false;
        this.setBusy(false);

        return;
      }

      let holder = form.querySelector('[data-rug-properties]');

      if (!holder) {
        holder = element('div');
        holder.hidden = true;
        holder.dataset.rugProperties = '';
        form.append(holder);
      }

      holder.replaceChildren(...Object.entries(this.properties(state)).map(([name, value]) => {
        const input = element('input');

        input.type = 'hidden';
        input.name = `properties[${name}]`;
        input.value = value;

        return input;
      }));

      form.id.value = state.variant;

      if (this.wantsSubmit) {
        const submitter = this.submitter;

        this.wantsSubmit = false;
        this.submitter = null;
        this.setBusy(false);

        try {
          form.requestSubmit(submitter);
        } catch (error) {
          form.requestSubmit();
        }
      }
    }

    setBusy(busy) {
      this.submitButtons.forEach((button) => {
        if (busy) {
          button.setAttribute('aria-busy', 'true');
        } else {
          button.removeAttribute('aria-busy');
        }
      });
    }

    money(cents) {
      return formatMoney(cents, this.config.moneyFormat);
    }

    showMessage(text) {
      const message = this.querySelector('[data-rug-message]');

      if (message) {
        message.querySelector('[data-rug-message-text]').textContent = text || '';
        message.hidden = !text;
      }
    }

    /**
     * Prints the price everywhere it shows: the summary, the price under the name and the bar that follows the page
     */
    showPrice(cents) {
      const text = cents === null ? '—' : this.money(cents),
        payNow = cents === null ? null : Math.floor((cents + 1) / 2),
        scope = this.closest('.shopify-section') || document;

      const print = (selector, value) => {
        const target = this.querySelector(selector);

        if (target) {
          target.textContent = value;
        }
      };

      print('[data-rug-total]', text);
      print('[data-rug-pay-now]', cents === null ? '—' : this.money(payNow));
      print('[data-rug-pay-later]', cents === null ? '—' : this.money(cents - payNow));

      scope.querySelectorAll('[data-block-type="price"] sale-price, product-sticky-bar sale-price').forEach((price) => {
        Array.from(price.childNodes).forEach((node) => {
          if (!(node.nodeType === Node.ELEMENT_NODE && node.classList.contains('sr-only'))) {
            node.remove();
          }
        });

        price.append(text);
      });

      scope.querySelectorAll('[data-rug-live-price]').forEach((price) => (price.textContent = text));
    }

    render(state) {
      const { config } = this,
        { strings } = config,
        valid = state.status !== 'invalid',
        editing = this.contains(document.activeElement) && document.activeElement.matches('[data-rug-width], [data-rug-length]'),
        showErrors = !valid && (this.forceErrors || !editing),
        error = this.querySelector('[data-rug-size-error]'),
        info = this.querySelector('[data-rug-size-info]'),
        note = this.querySelector('[data-rug-size-note]');

      const print = (selector, value) => {
        const target = this.querySelector(selector);

        if (target) {
          target.textContent = value;
        }
      };

      // Size
      this.querySelectorAll('[data-rug-size]').forEach((size) => {
        const sizeWidth = parseInt(size.dataset.width, 10),
          sizeLength = parseInt(size.dataset.length, 10);

        size.setAttribute('aria-pressed', String(('round' in size.dataset) === (state.round === true) && ((sizeWidth === state.width && sizeLength === state.length) || (sizeWidth === state.length && sizeLength === state.width))));
      });

      error.textContent = showErrors ? state.errors.join(' ') : '';
      error.hidden = !showErrors;

      // A rug whose level allows no size of its own has no size fields
      [this.widthInput, this.lengthInput].filter(Boolean).forEach((input) => {
        if (showErrors) {
          input.setAttribute('aria-invalid', 'true');
        } else {
          input.removeAttribute('aria-invalid');
        }
      });

      info.hidden = !valid;

      if (valid) {
        info.textContent = state.round
          ? `Ø ${state.width} cm · ${strings.area.replace('[area]', state.area)} · ${strings.about.replace('[size]', `Ø ${feetAndInches(state.width)}`)}`
          : `${strings.area.replace('[area]', state.area)} · ${strings.about.replace('[size]', `${feetAndInches(state.width)} × ${feetAndInches(state.length)}`)}`;
      }

      // Under the size: the supplement of the format, and how an oval is priced
      const notes = valid ? [state.reason ? strings[state.reason] : '', state.shape === 'oval' ? strings.oval : ''].filter(Boolean) : [];

      note.hidden = notes.length === 0;
      note.textContent = notes.join(' ');

      // The choices that are buttons: the one in use is the pressed one
      this.querySelectorAll('[data-rug-shape]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.rugShape === this.shape)));
      this.querySelectorAll('[data-rug-material]').forEach((button) => button.setAttribute('aria-pressed', String(parseInt(button.dataset.rugMaterial, 10) === this.material)));
      this.querySelectorAll('[data-rug-pile]').forEach((button) => button.setAttribute('aria-pressed', String(parseInt(button.dataset.rugPile, 10) === this.pile)));

      // Summary
      print('[data-rug-summary-material]', this.materialValue?.name || '');
      print('[data-rug-summary-pile]', this.pile === null ? '' : `${strings.millimetres.replace('[height]', this.pileHeight)}${this.pilePercent(this.pile) > 0 ? ` (+${this.pilePercent(this.pile)}%)` : ''}`);
      print('[data-rug-summary-shape]', `${strings.shapeNames[state.shape]}${state.shape === 'corners' && config.corners > 0 ? ` (+${config.corners}%)` : ''}`);
      print('[data-rug-summary-size]', valid ? `${state.round ? `Ø ${state.width} cm` : `${state.width} × ${state.length} cm`} · ${strings.area.replace('[area]', state.area)}` : '—');
      print('[data-rug-summary-supplement]', valid && state.reason ? strings[state.reason] : '');
      this.querySelector('[data-rug-summary-supplement-row]').hidden = !valid || !state.reason;

      const changedText = state.changed === 0 ? '' : (state.changed === 1 ? strings.changedOne : strings.changedOther.replace('[count]', state.changed));

      if (this.colours.some((colour) => colour.fromCard)) {
        // Colours chosen on the card of the material: the summary names them
        print('[data-rug-summary-colours]', this.colours.map((colour) => this.describeColour(colour, false)).join(' · '));
      } else if (config.choice?.colour) {
        // The colourway, then what was changed in it
        print('[data-rug-summary-colours]', [this.choiceValue?.name, changedText].filter(Boolean).join(' · '));
      } else {
        print('[data-rug-summary-colours]', changedText || strings.asShown);
      }

      print('[data-rug-summary-choice]', this.choiceValue?.name || '');

      print('[data-rug-summary-shipping]', afterHeading(state.express ? strings.express : strings.standard, strings.propertyShipping));
      print('[data-rug-express-extra]', valid && state.expressExtra > 0 ? strings.surcharge.replace('[amount]', this.money(state.expressExtra)) : strings.percent);

      this.showMessage(state.status === 'quote' ? strings.onRequest : '');
      this.syncSample();

      // Price: known at once in the shop's currency, and after the look-up in any other
      if (!valid || state.status === 'quote') {
        this.showPrice(null);
      } else if (state.status === 'own' || config.baseCurrency) {
        this.showPrice(state.cents);
      } else {
        this.toggleAttribute('data-rug-busy', true);
      }
    }
  }

  window.customElements.define('rug-configurator', RugConfigurator);
})();
