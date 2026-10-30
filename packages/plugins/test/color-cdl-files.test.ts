// color-cdl-files, on the CPU. Checked: the .cc, .ccc and .cdl forms are read; a read, written and
// read again correction is the same; a missing SOPNode or SatNode is identity; what real tools
// write (a namespace, a declaration, comments, CRLF, a BOM, numbers over lines) is read; bad files
// are refused with what is wrong; and a correction read from a file, through color-primary's cdl,
// gives the value worked by hand.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Cdl, readCdl, writeCdl } from '../color-cdl-files/src/color/cdl-files.ts'
import { cdl } from '../color-primary/src/color/primary.ts'

const cc = (id: string, slope = '1 1 1', sat = '1') => `<ColorCorrection id="${id}">
  <SOPNode>
    <Slope>${slope}</Slope>
    <Offset>0 0 0</Offset>
    <Power>1 1 1</Power>
  </SOPNode>
  <SatNode>
    <Saturation>${sat}</Saturation>
  </SatNode>
</ColorCorrection>`

test('color-cdl-files: the .cc, .ccc and .cdl forms are read', () => {
  const one = readCdl(`<?xml version="1.0" encoding="UTF-8"?>
<ColorCorrection id="sh010" xmlns="urn:ASC:CDL:v1.2">
  <Description>warm &amp; low</Description>
  <SOPNode>
    <Description>ignored</Description>
    <Slope>1.2 1.0 0.8</Slope>
    <Offset>0.01 0 -0.02</Offset>
    <Power>1 1.2 1</Power>
  </SOPNode>
  <SatNode>
    <Saturation>0.9</Saturation>
  </SatNode>
</ColorCorrection>`)
  assert.deepStrictEqual(one, [
    {
      id: 'sh010',
      description: 'warm & low',
      slope: [1.2, 1, 0.8],
      offset: [0.01, 0, -0.02],
      power: [1, 1.2, 1],
      saturation: 0.9,
    },
  ])

  const collection = readCdl(
    `<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.2">\n${cc('a', '1.1 1 1')}\n${cc('b', '1 1 0.9', '0.5')}\n</ColorCorrectionCollection>`,
  )
  assert.deepEqual(
    collection.map((c) => [c.id, c.slope, c.saturation]),
    [
      ['a', [1.1, 1, 1], 1],
      ['b', [1, 1, 0.9], 0.5],
    ],
  )

  const list = readCdl(`<ColorDecisionList xmlns="urn:ASC:CDL:v1.2">
  <ColorDecision>
    <MediaRef ref="A001C003.mov"/>
    ${cc('A001C003', '0.9 1 1.1')}
  </ColorDecision>
  <ColorDecision>${cc('A001C004')}</ColorDecision>
</ColorDecisionList>`)
  assert.deepEqual(
    list.map((c) => [c.id, c.slope]),
    [
      ['A001C003', [0.9, 1, 1.1]],
      ['A001C004', [1, 1, 1]],
    ],
  )
})

test('color-cdl-files: read, write and read again is the same', () => {
  const corrections: Cdl[] = [
    {
      id: 'a "quoted" <id> & more',
      description: 'one < two',
      slope: [1.012345678901234, 0.5, 2],
      offset: [-0.125, 1e-7, 0],
      power: [0.8, 1, 1.25],
      saturation: 1.1,
    },
    { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 },
  ]
  for (const form of ['ccc', 'cdl'] as const) {
    const text = writeCdl(corrections, form)
    assert.match(text, /xmlns="urn:ASC:CDL:v1\.2"/)
    assert.deepStrictEqual(readCdl(text), corrections, form)
    assert.equal(writeCdl(readCdl(text), form), text, form)
  }
  const single = [corrections[0] as Cdl]
  assert.match(
    writeCdl(single, 'cc'),
    /^<\?xml[^>]*>\n<ColorCorrection xmlns="urn:ASC:CDL:v1\.2" id=/,
  )
  assert.deepStrictEqual(readCdl(writeCdl(single, 'cc')), single)
  assert.match(
    writeCdl(single, 'cdl'),
    /<ColorDecisionList[^>]*>\n {2}<ColorDecision>\n {4}<ColorCorrection/,
  )
  assert.throws(() => writeCdl(corrections, 'cc'), /a \.cc file holds one correction, not 2/)
  assert.throws(() => writeCdl([], 'ccc'), /no corrections/)
  assert.throws(
    () => writeCdl([{ ...single[0], slope: [1, Number.NaN, 1] } as Cdl], 'ccc'),
    /slope must be finite numbers/,
  )
})

test('color-cdl-files: a missing SOPNode or SatNode is identity', () => {
  const [onlySat, onlySop, empty, closed] = readCdl(`<ColorCorrectionCollection>
<ColorCorrection id="s"><SatNode><Saturation>0.5</Saturation></SatNode></ColorCorrection>
<ColorCorrection id="p"><SOPNode><Slope>2 2 2</Slope><Offset>0.1 0.1 0.1</Offset><Power>1 1 1</Power></SOPNode></ColorCorrection>
<ColorCorrection></ColorCorrection>
<ColorCorrection id="z"/>
</ColorCorrectionCollection>`)
  assert.deepStrictEqual(onlySat, {
    id: 's',
    slope: [1, 1, 1],
    offset: [0, 0, 0],
    power: [1, 1, 1],
    saturation: 0.5,
  })
  assert.deepEqual([onlySop?.slope, onlySop?.saturation], [[2, 2, 2], 1])
  assert.deepStrictEqual(empty, {
    slope: [1, 1, 1],
    offset: [0, 0, 0],
    power: [1, 1, 1],
    saturation: 1,
  })
  assert.equal(closed?.id, 'z')
})

test('color-cdl-files: what real tools write is read', () => {
  const resolve = `﻿<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r
<!-- exported by a grading tool -->\r
<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.01">\r
  <!-- <ColorCorrection id="commented-out"/> -->\r
  <ColorCorrection id='reel 1'>\r
    <SOPNode>\r
      <Slope>\r
        1.05\r
        1.0\r
        0.95\r
      </Slope>\r
      <Offset>  0.001   -0.002\t0.003  </Offset>\r
      <Power>1.0 1.0 1.0</Power>\r
    </SOPNode>\r
    <SATNode><Saturation> 0.8 </Saturation></SATNode>\r
  </ColorCorrection>\r
</ColorCorrectionCollection>\r
`
  assert.deepStrictEqual(readCdl(resolve), [
    {
      id: 'reel 1',
      slope: [1.05, 1, 0.95],
      offset: [0.001, -0.002, 0.003],
      power: [1, 1, 1],
      saturation: 0.8,
    },
  ])
  const prefixed = readCdl(
    '<cdl:ColorCorrection xmlns:cdl="urn:ASC:CDL:v1.2" id="x"><cdl:SOPNode><cdl:Slope>2 1 1</cdl:Slope><cdl:Offset>0 0 0</cdl:Offset><cdl:Power>1 1 1</cdl:Power></cdl:SOPNode></cdl:ColorCorrection>',
  )
  assert.deepEqual(prefixed[0]?.slope, [2, 1, 1])
})

test('color-cdl-files: bad files are refused, saying what is wrong', () => {
  assert.throws(() => readCdl(''), /no ColorCorrection found/)
  assert.throws(
    () => readCdl('<ColorDecisionList></ColorDecisionList>'),
    /no ColorCorrection found/,
  )
  assert.throws(
    () => readCdl(cc('a', '1 1')),
    /ColorCorrection "a": Slope needs 3 numbers, not "1 1"/,
  )
  assert.throws(() => readCdl(cc('a', '1 1 1 1')), /Slope needs 3 numbers/)
  assert.throws(() => readCdl(cc('a', '1 one 1')), /Slope needs 3 numbers, not "1 one 1"/)
  assert.throws(() => readCdl(cc('a', '1 1 1', '0.5 0.5')), /Saturation needs 1 number/)
  assert.throws(() => readCdl(cc('a', '1 0x10 1')), /Slope needs 3 numbers/)
  assert.throws(
    () => readCdl('<ColorCorrection id="b"><SOPNode><Slope>1 1 1</SOPNode></ColorCorrection>'),
    /ColorCorrection "b": Slope is not closed/,
  )
  assert.throws(
    () => readCdl(`<ColorCorrectionCollection>${cc('a')}<ColorCorrection id="c"><SOPNode>`),
    /ColorCorrection 2 is not closed/,
  )
})

const identity = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 }

test('color-cdl-files: values are read only inside their nodes, as OpenColorIO reads them', () => {
  // Shaped like OCIO's cdl_test_ASC_SAT.cc and cdl_test_ASC_SOP.cc: values outside their node.
  const [sat] = readCdl(`<ColorCorrection id="sat">
  <SOPNode><Slope>1 1 1</Slope><Offset>0 0 0</Offset><Power>1 1 1</Power></SOPNode>
  <Saturation>0.42</Saturation>
</ColorCorrection>`)
  assert.equal(sat?.saturation, 1)
  const [sop] = readCdl(`<ColorCorrection id="sop">
  <SatNode><Description>ASC_SOP</Description><Saturation>1</Saturation></SatNode>
  <Slope>2 2 2</Slope><Offset>0.1 0.1 0.1</Offset><Power>2 2 2</Power>
</ColorCorrection>`)
  assert.deepStrictEqual(sop, { id: 'sop', ...identity })
})

test('color-cdl-files: a SOPNode needs Slope, Offset and Power', () => {
  assert.throws(
    () => readCdl('<ColorCorrection><SOPNode/></ColorCorrection>'),
    /SOPNode needs Slope, Offset and Power/,
  )
  assert.throws(
    () =>
      readCdl(
        '<ColorCorrection><SOPNode><slope>1 1 1</slope><Offset>0 0 0</Offset><Power>1 1 1</Power></SOPNode></ColorCorrection>',
      ),
    /Slope is missing/,
  )
  assert.throws(
    () =>
      readCdl(
        '<ColorCorrection><SOPNode><Slope>1 1 1</Slope><Offset>0 0 0</Offset></SOPNode></ColorCorrection>',
      ),
    /Power is missing/,
  )
})

test('color-cdl-files: CDATA is text, not tags', () => {
  const [c] = readCdl(`<ColorCorrection>
  <Description><![CDATA[a < b & <Slope>9 9 9</Slope>]]></Description>
</ColorCorrection>`)
  assert.deepStrictEqual(c, { description: 'a < b & <Slope>9 9 9</Slope>', ...identity })
  assert.throws(() => readCdl(`${cc('a')}<![CDATA[ open`), /comment or CDATA is not closed/)
})

test('color-cdl-files: values out of the ASC ranges are refused', () => {
  assert.throws(() => readCdl(cc('a', '1 1e400 1')), /Slope needs 3 numbers, not "1 1e400 1"/)
  assert.throws(() => readCdl(cc('a', '1 -0.1 1')), /Slope must be 0 or above/)
  assert.throws(() => readCdl(cc('a', '1 1 1', '-0.5')), /Saturation must be 0 or above/)
  assert.throws(
    () => readCdl(cc('a').replace('<Power>1 1 1', '<Power>1 0 1')),
    /Power must be above 0/,
  )
  assert.deepEqual(readCdl(cc('a', '0 0 0', '0'))[0]?.slope, [0, 0, 0])
})

test('color-cdl-files: an id used twice in one file is refused', () => {
  assert.throws(
    () => readCdl(`<ColorCorrectionCollection>${cc('a')}${cc('a')}</ColorCorrectionCollection>`),
    /the id "a" is used twice/,
  )
  assert.equal(readCdl(`${cc('')}${cc('')}<ColorCorrection/><ColorCorrection/>`).length, 4)
})

test('color-cdl-files: an unclosed comment does not bring a correction back', () => {
  assert.throws(() => readCdl(`${cc('a')}<!-- ${cc('b')}`), /comment or CDATA is not closed/)
})

test('color-cdl-files: the id is the id attribute, quoted values whole', () => {
  assert.equal(readCdl('<ColorCorrection data-id="no"/>')[0]?.id, undefined)
  assert.equal(readCdl('<ColorCorrection data-id="no" id="yes"/>')[0]?.id, 'yes')
  assert.equal(readCdl('<ColorCorrection id="a>b"/>')[0]?.id, 'a>b')
  assert.equal(readCdl(cc('a>b'))[0]?.id, 'a>b')
})

test('color-cdl-files: a correction read from a file, through color-primary, gives the value worked by hand', () => {
  const [g] = readCdl(`<ColorDecisionList xmlns="urn:ASC:CDL:v1.2"><ColorDecision>
<ColorCorrection id="hand"><SOPNode><Slope>2 1 1</Slope><Offset>0 0 0.1</Offset><Power>1 2 1</Power></SOPNode>
<SatNode><Saturation>0.5</Saturation></SatNode></ColorCorrection></ColorDecision></ColorDecisionList>`)
  if (!g) throw new Error('no correction')
  // (0.25, 0.5, 0.5): SOP gives (0.5, 0.25, 0.6); Rec.709 luma 0.2126·0.5 + 0.7152·0.25 + 0.0722·0.6
  // = 0.32842; saturation 0.5 halves each channel's distance from it.
  const got = cdl([0.25, 0.5, 0.5], g.slope, g.offset, g.power, g.saturation)
  const want = [0.41421, 0.28921, 0.46421]
  assert.ok(
    got.every((v, i) => Math.abs(v - (want[i] ?? Number.NaN)) < 1e-12),
    `${got} is not ${want}`,
  )
})
