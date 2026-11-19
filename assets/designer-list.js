/**
 * Corvo: the search box of the list of designers (see sections/designer-list.liquid).
 *
 * The cards are already in the page. As one types, the cards whose name, studio, place or rugs do not hold every word
 * typed are hidden, and the line under the box says how many remain. Accents are ignored, so "Sa" finds "Sá".
 */
(() => {
  if (window.customElements.get('designer-list')) {
    return;
  }

  function plain(text) {
    return (text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  }

  class DesignerList extends HTMLElement {
    connectedCallback() {
      this.input = this.querySelector('[data-designer-search]');

      if (!this.input) {
        return;
      }

      this.items = Array.from(this.querySelectorAll('[data-designer-item]'));
      this.status = this.querySelector('[data-designer-status]');
      this.none = this.querySelector('[data-designer-none]');
      this.input.addEventListener('input', () => this.filter());

      // A search carried in the address, such as /pages/designers?designer=lisbon, fills the box
      const carried = new URL(window.location.href).searchParams.get('designer');

      if (carried) {
        this.input.value = carried;
      }

      this.filter();
    }

    filter() {
      const words = plain(this.input.value).split(/\s+/).filter(Boolean),
        total = this.items.length;

      let shown = 0;

      this.items.forEach((item) => {
        const text = plain(item.dataset.search),
          match = words.every((word) => text.includes(word));

        item.hidden = !match;

        if (match) {
          shown += 1;
        }
      });

      if (this.none) {
        this.none.hidden = shown > 0;
      }

      if (this.status) {
        const { textCountOne, textCountOther, textCountFiltered } = this.dataset;

        this.status.textContent = words.length === 0
          ? (total === 1 ? textCountOne : textCountOther).replace('%c', total)
          : textCountFiltered.replace('%c', shown).replace('%t', total);
      }
    }
  }

  window.customElements.define('designer-list', DesignerList);
})();
