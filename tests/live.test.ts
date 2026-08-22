import { describe, expect, it } from 'vitest';

import { AbsClient } from '../src/abs-client.js';

const liveIt = process.env.RUN_LIVE_TESTS === '1' ? it : it.skip;

describe('live ABS API', () => {
  liveIt(
    'discovers the ALC schema and retrieves one known observation',
    async () => {
      const client = new AbsClient();
      const search = await client.searchDataflows('Apparent Consumption of Alcohol', 2, 0);
      expect(search.items.some(({ id }) => id === 'ALC')).toBe(true);

      const structure = await client.getDataflowStructure('ALC');
      expect(structure.dimensions.map(({ id }) => id)).toEqual([
        'TYP',
        'MEA',
        'BEVT',
        'SUB',
        'FREQUENCY',
      ]);
      expect(structure.timeDimensions.map(({ id }) => id)).toContain('TIME_PERIOD');

      const typeCodelist = structure.dimensions.find(({ id }) => id === 'TYP')?.codelist;
      expect(typeCodelist).toBeDefined();
      const codelist = await client.getCodelist(
        typeCodelist?.id ?? 'CL_ALC_TYP',
        'pure alcohol',
        5,
        0,
        typeCodelist?.agencyId ?? 'ABS',
        typeCodelist?.version ?? 'latest',
      );
      expect(codelist.codes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: '1', name: 'Volume of pure alcohol' }),
        ]),
      );

      const result = await client.queryData({
        agencyId: 'ABS',
        dataKey: '1.2.1.4.A',
        dataflowId: 'ALC',
        detail: 'full',
        dimensionAtObservation: 'AllDimensions',
        endPeriod: '2008',
        format: 'csv',
        maxOutputChars: 10_000,
        maxRows: 10,
        startPeriod: '2008',
        version: 'latest',
      });

      expect(result.truncated).toBe(false);
      expect(result.body).toContain('2008');
      expect(result.body).toContain('0.56');
    },
    60_000,
  );
});
