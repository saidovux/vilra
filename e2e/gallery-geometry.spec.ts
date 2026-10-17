import {expect, test} from '@playwright/test';

import {
  aspectCss,
  calculateVirtualCardLayout,
  computeGalleryGeometry,
  estimateVirtualCardSize,
  imageAspectRatio,
  virtualItemIsNear,
  virtualItemIsVisible,
  type GalleryGeometry,
} from '../static/src/gallery/geometry';

const geometry: GalleryGeometry = {
  width: 1000,
  gap: 10,
  laneCount: 4,
  laneWidth: 242.5,
  borderWidth: 1,
  scrollMargin: 120,
};

test('image geometry preserves portrait landscape and square ratios', () => {
  expect(imageAspectRatio({width: 400, height: 800})).toBe(0.5);
  expect(imageAspectRatio({width: 1200, height: 600})).toBe(2);
  expect(imageAspectRatio({width: 640, height: 640})).toBe(1);
  expect(aspectCss({width: 400, height: 800})).toBe('400 / 800');
  expect(aspectCss({aspect_ratio: 1.5})).toBe('1500 / 1000');
  expect(imageAspectRatio({aspect_ratio: Number.NaN})).toBe(1);
});

test('gallery geometry keeps the existing responsive lane formulas', () => {
  expect(computeGalleryGeometry({
    galleryWidth: 700,
    viewportWidth: 1920,
    gap: 10,
    scrollMargin: 80,
  })).toEqual({
    width: 700,
    gap: 10,
    laneCount: 1,
    laneWidth: 700,
    borderWidth: 1,
    scrollMargin: 80,
  });

  expect(computeGalleryGeometry({
    galleryWidth: 1000,
    viewportWidth: 1920,
    gap: 10,
    scrollMargin: 120,
  })).toEqual(geometry);

  const wide = computeGalleryGeometry({
    galleryWidth: 0,
    viewportWidth: 1920,
    gap: 10,
    scrollMargin: 160,
  });
  expect(wide.laneCount).toBe(8);
  expect(wide.laneWidth).toBeCloseTo(231.25);
  expect(wide.scrollMargin).toBe(160);
});

test('virtual card estimates preserve aspect ratio and border sizing', () => {
  expect(estimateVirtualCardSize({width: 400, height: 800}, geometry)).toBe(483);
  expect(estimateVirtualCardSize({width: 1200, height: 600}, geometry)).toBe(122.25);
  expect(estimateVirtualCardSize({width: 640, height: 640}, geometry)).toBe(242.5);
  expect(estimateVirtualCardSize(undefined, geometry)).toBe(218);
});

test('visibility includes both viewport boundaries with a nonzero scroll margin', () => {
  const viewport = {scrollY: 300, height: 600};
  expect(virtualItemIsVisible({start: 100, end: 300}, geometry, viewport)).toBe(true);
  expect(virtualItemIsVisible({start: 100, end: 299.99}, geometry, viewport)).toBe(false);
  expect(virtualItemIsVisible({start: 900, end: 950}, geometry, viewport)).toBe(true);
  expect(virtualItemIsVisible({start: 900.01, end: 950}, geometry, viewport)).toBe(false);
});

test('near-zone follows scroll direction and existing lookahead distance', () => {
  const viewport = {scrollY: 1500, height: 800};
  expect(virtualItemIsNear({start: 1300, end: 1420}, geometry, 'backward', viewport)).toBe(true);
  expect(virtualItemIsNear({start: 600, end: 700}, geometry, 'backward', viewport)).toBe(false);
  expect(virtualItemIsNear({start: 2321, end: 2400}, geometry, 'forward', viewport)).toBe(true);
  expect(virtualItemIsNear({start: 2921, end: 3000}, geometry, 'forward', viewport)).toBe(false);
  expect(virtualItemIsNear({start: 2321, end: 2400}, geometry, null, viewport)).toBe(true);
});

test('virtual card layout preserves masonry lane coordinates', () => {
  expect(calculateVirtualCardLayout({
    index: 7,
    lane: 2,
    start: 920,
    end: 1162.5,
    size: 242.5,
  }, geometry)).toEqual({
    index: 7,
    lane: 2,
    width: 242.5,
    height: 242.5,
    x: 505,
    y: 800,
  });
});
