/**
 * Corvo addition: a filter for a list that is already on the page.
 *
 * The page lists everything as plain HTML (the designs of the design library, the projects of the Portfolio), so a
 * reader that does not run scripts sees the whole list, and each filter link is a plain link to a part of the page.
 * This element turns those links into a filter: it hides the items of the other groups, keeps the address of the page
 * in step (?style=relief), numbers the items that stay and says how many are shown.
 *
 *   <corvo-filter param="style" status="[count] designs shown">
 *     <a href="#style-relief" data-filter="relief">Relief</a>     a filter link ("" shows everything)
 *     <section data-filter-item="relief">…</section>              an item, or a group of items, of that filter
 *     <span data-filter-number></span>                            inside an item: its place among the shown items
 *     <span data-filter-total></span>                             inside an item: how many items are shown
 *     <p data-filter-status></p>                                  says how many are shown, for screen readers
 *   </corvo-filter>
 *
 * With alternate="some-class", every second item that is shown gets that class (a layout that alternates sides).
 */
(() => {
  if (window.customElements.get('corvo-filter')) {
    return;
  }

  const twoDigits = (number) => String(number).padStart(2, '0');

  class CorvoFilter extends HTMLElement {
    connectedCallback() {
      this.param = this.getAttribute('param') || 'filter';
      this.links = Array.from(this.querySelectorAll('[data-filter]'));
      this.items = Array.from(this.querySelectorAll('[data-filter-item]'));

      if (this.links.length === 0 || this.items.length === 0) {
        return;
      }

      this.addEventListener('click', (event) => {
        const link = event.target.closest('[data-filter]');

        if (!link || !this.contains(link)) {
          return;
        }

        event.preventDefault();
        this.choose(link.dataset.filter, true);
      });

      // A filter given in the address of the page is applied as the page opens
      const asked = new URLSearchParams(window.location.search).get(this.param);

      if (asked && this.links.some((link) => link.dataset.filter === asked)) {
        this.apply(asked);
      }
    }

    choose(value, animate) {
      const url = new URL(window.location.href);

      if (value) {
        url.searchParams.set(this.param, value);
      } else {
        url.searchParams.delete(this.param);
      }

      window.history.replaceState(window.history.state, '', url);

      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (animate && !still && document.startViewTransition) {
        document.startViewTransition(() => this.apply(value));
      } else {
        this.apply(value);
      }
    }

    apply(value) {
      const alternate = this.getAttribute('alternate'),
        shown = this.items.filter((item) => !value || item.dataset.filterItem === value);

      this.items.forEach((item) => {
        item.hidden = !shown.includes(item);
      });

      this.links.forEach((link) => {
        if (link.dataset.filter === value) {
          link.setAttribute('aria-current', 'true');
        } else {
          link.removeAttribute('aria-current');
        }
      });

      shown.forEach((item, index) => {
        item.querySelectorAll('[data-filter-number]').forEach((element) => {
          element.textContent = twoDigits(index + 1);
        });

        item.querySelectorAll('[data-filter-total]').forEach((element) => {
          element.textContent = twoDigits(shown.length);
        });

        if (alternate) {
          item.classList.toggle(alternate, index % 2 === 1);
        }
      });

      // How many are shown: the items themselves, or what each group of items holds
      const status = this.querySelector('[data-filter-status]');

      if (status) {
        const count = shown.reduce((total, item) => total + (Number(item.dataset.filterCount) || 1), 0);

        status.textContent = (this.getAttribute('status') || '').replace('[count]', count);
      }
    }
  }

  window.customElements.define('corvo-filter', CorvoFilter);
})();
