import { describe, expect, it } from 'vitest';
import { endsWithQuestion, replyOptions } from './prose-question';

describe('endsWithQuestion', () => {
  it('sees a question at the end, through markdown decoration', () => {
    expect(endsWithQuestion('Done.\n\nShould I use Vitest or Jest?')).toBe(true);
    expect(endsWithQuestion('Done.\n\n**Which one do you prefer?**')).toBe(true);
    expect(endsWithQuestion('Ready? \n')).toBe(true);
  });
  it('ignores a question that is not the end, and code', () => {
    expect(endsWithQuestion('Why? Because it works.')).toBe(false);
    expect(endsWithQuestion('Here it is:\n```\nx ?\n```')).toBe(false);
    expect(endsWithQuestion('')).toBe(false);
  });
});

describe('replyOptions', () => {
  it('reads "A, B or C?"', () => {
    expect(replyOptions('Should I use Vitest, Jest or Mocha?')).toEqual(['Vitest', 'Jest', 'Mocha']);
    expect(replyOptions('All set. Do you want the Observable version or the generator?')).toEqual(['the Observable version', 'the generator']);
    expect(replyOptions('Do you prefer tabs, or spaces?')).toEqual(['tabs', 'spaces']);
  });
  it('reads a list right above the question', () => {
    expect(replyOptions('There are two ways:\n\n1. Rebase - keeps history linear\n2. Merge - keeps the branches\n\nWhich one?')).toEqual(['Rebase', 'Merge']);
    expect(replyOptions('Options:\n- **Alpha**\n- **Beta**\nWhich do you want?')).toEqual(['Alpha', 'Beta']);
  });
  it('offers nothing for a question that lists nothing, or a long sentence', () => {
    expect(replyOptions('Shall I continue?')).toEqual([]);
    expect(replyOptions('Do you want me to refactor the whole module so that every caller gets the new signature or leave it?')).toEqual([]);
    expect(replyOptions('Done.')).toEqual([]);
  });
});
