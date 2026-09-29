import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EmbedBuilder } from 'discord.js';
import { renderEmbed } from '../embeds/render.js';
import { builderMessage, editorModal } from '../embeds/ui.js';
import { createSession } from '../embeds/session.js';
import { EmbedConfigSchema } from '../embeds/contract.js';
import { renderTicketEmbed, TRANSCRIPT_NOTICE } from './render.js';

for (const text of [undefined, 'Server footer', `Server footer • ${TRANSCRIPT_NOTICE}`, `${TRANSCRIPT_NOTICE} • Server footer • ${TRANSCRIPT_NOTICE}`]) {
    it(`enforces a single notice while preserving config: ${text}`, () => {
        const config = EmbedConfigSchema.parse({ title: 'Support', description: 'Ask here', color: 123,
            fields: [{ name: 'Help', value: 'Details' }], image: { url: 'https://example.com/image.png' },
            thumbnail: { url: 'https://example.com/thumb.png' },
            footer: text ? { text, icon_url: 'https://example.com/icon.png' } : undefined });
        const before = structuredClone(config), rendered = renderTicketEmbed(config);
        assert.equal(rendered.footer!.text.split(TRANSCRIPT_NOTICE).length - 1, 1);
        assert.deepEqual(rendered.footer, { text: TRANSCRIPT_NOTICE });
        assert.deepEqual({ ...rendered, footer: undefined }, { ...config, footer: undefined });
        assert.deepEqual(config, before);
        assert.deepEqual(renderTicketEmbed(EmbedConfigSchema.parse(rendered)), rendered);
        assert.deepEqual(new EmbedBuilder(rendered).toJSON(), rendered);
    });
}
it('reserves footer and total character budget without altering other content', () => {
    const config = EmbedConfigSchema.parse({ description: 'x'.repeat(3900), footer: { text: 'f'.repeat(2048) } });
    const rendered = renderTicketEmbed(config); assert.deepEqual(rendered.footer, { text: TRANSCRIPT_NOTICE });
    assert.ok(rendered.footer!.text.endsWith(TRANSCRIPT_NOTICE)); assert.equal(rendered.description, config.description);
    const full = EmbedConfigSchema.parse({ description: 'x'.repeat(4096), fields: [{ name: 'N', value: 'x'.repeat(1024) }, { name: 'M', value: 'x'.repeat(878) }] });
    assert.throws(() => renderTicketEmbed(full), /6000 text characters/);
});

it('general embed rendering and editing preserve arbitrary footers and add no default notice', () => {
    const config = EmbedConfigSchema.parse({ title: 'General embed', footer: { text: 'Custom server footer', icon_url: 'https://example.com/icon.png' } });
    assert.deepEqual(renderEmbed(config).footer, config.footer);
    assert.equal(renderEmbed(EmbedConfigSchema.parse({ title: 'No footer' })).footer, undefined);
    const session = createSession('100000000000000001', '100000000000000002');
    session.config = config;
    const preview = builderMessage(session);
    assert.deepEqual(preview.embeds[0].footer, config.footer);
    assert.match(JSON.stringify(preview.components), /"value":"Footer"/);
    assert.match(JSON.stringify(editorModal(session, 'Footer')), /Custom server footer/);
    assert.ok(!JSON.stringify(preview).includes(TRANSCRIPT_NOTICE));
});
