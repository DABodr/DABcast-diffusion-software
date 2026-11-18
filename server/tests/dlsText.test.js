// cleanDlsText (utils/dlplus.js): DLS text broken upstream is repaired before it goes on air,
// correct text is never changed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDlsText } from '../src/utils/dlplus.js';

describe('cleanDlsText', () => {
  it('a character lost at the source (FG: double-encoded "�") becomes "?"', () => {
    assert.equal(cleanDlsText('ELIAD COHEN & ODELLY - DerniÃ¯Â¿Â½re danse'), 'ELIAD COHEN & ODELLY - Derni?re danse');
    assert.equal(cleanDlsText('Derni�re'), 'Derni?re');
  });

  it('UTF-8 read as Latin-1 is repaired', () => {
    assert.equal(cleanDlsText('INDILA - DerniÃ¨re danse'), 'INDILA - Dernière danse');
    assert.equal(cleanDlsText('Ã\u0083Â¨'), 'è', 'twice');
  });

  it('correct text is unchanged', () => {
    for (const s of ['INDILA - Dernière danse', 'Beyoncé - Déjà vu', 'Café « Paris » 2€',
      'Ofenbach — Miles away ’ 🎵', 'plain ascii', 'Ã‰té', '', 'Ça va - Naïve']) {
      assert.equal(cleanDlsText(s), s);
    }
    assert.equal(cleanDlsText(undefined), '');
  });
});
