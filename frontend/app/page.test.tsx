import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Home from './page.js';

test('customer home renders the pilot service catalog and persona navigation', () => {
  const markup = renderToStaticMarkup(createElement(Home));

  assert.match(markup, /Choose your care/);
  assert.match(markup, /Wash &amp; fold/);
  assert.match(markup, /Dry cleaning/);
  assert.match(markup, /Ironing/);
  assert.match(markup, /Laundry partner/);
  assert.match(markup, /Courier/);
  assert.match(markup, /Karu/);
  assert.match(markup, /Mararaba/);
});
