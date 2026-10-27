import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';

/**
 * The pi-kit documentation site. The pages under `docs/` are the source: the architecture, the repository structure, the design
 * system, the plugin contract and the decision records. `.md` files are CommonMark (so a record may contain `<token>` and `{}`
 * as written); a page that needs JSX is `.mdx`. Diagrams are Mermaid code blocks.
 */
const config: Config = {
  title: 'pi-kit',
  tagline: 'A desktop UI for the pi coding agent',
  favicon: 'img/mark-gold-256.png',
  url: 'https://wolfmanfx.github.io',
  baseUrl: '/pi-kit/',
  organizationName: 'wolfmanfx',
  projectName: 'pi-kit',
  trailingSlash: false,
  onBrokenLinks: 'warn',
  onBrokenAnchors: 'warn',
  markdown: {
    format: 'detect',
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: 'warn' },
  },
  themes: ['@docusaurus/theme-mermaid'],
  i18n: { defaultLocale: 'en', locales: ['en'] },
  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          // The ADR index is the "Decision records" group's own entry (sidebars.ts), so it is not listed inside the group as well.
          sidebarItemsGenerator: async ({ defaultSidebarItemsGenerator, ...args }) => {
            const items = await defaultSidebarItemsGenerator(args);
            return items.filter((item) => !(item.type === 'doc' && item.id === 'adr/README'));
          },
          numberPrefixParser: false,
          editUrl: 'https://github.com/wolfmanfx/pi-kit/tree/main/doc/',
          showLastUpdateTime: false,
        },
        blog: false,
        pages: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    image: 'img/wordmark.png',
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: 'pi-kit',
      logo: { alt: 'pi-kit', src: 'img/mark-gold-256.png' },
      items: [
        { type: 'doc', docId: 'architecture', position: 'left', label: 'Architecture' },
        { type: 'doc', docId: 'backend', position: 'left', label: 'Backend' },
        { type: 'doc', docId: 'structure', position: 'left', label: 'Structure' },
        { type: 'doc', docId: 'design-system', position: 'left', label: 'Design system' },
        { to: '/adr', position: 'left', label: 'Decisions' },
        { href: 'https://github.com/wolfmanfx/pi-kit', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Read',
          items: [
            { label: 'Architecture', to: '/architecture' },
            { label: 'Backend', to: '/backend' },
            { label: 'Repository structure', to: '/structure' },
            { label: 'Design system', to: '/design-system' },
            { label: 'Plugins', to: '/plugins' },
          ],
        },
        {
          title: 'Decide',
          items: [{ label: 'Decision records', to: '/adr' }],
        },
        {
          title: 'Code',
          items: [{ label: 'GitHub', href: 'https://github.com/wolfmanfx/pi-kit' }],
        },
      ],
      copyright: `Built by Soverius.AI GmbH.`,
    },
    prism: { theme: prismThemes.github, darkTheme: prismThemes.dracula, additionalLanguages: ['bash', 'json', 'yaml'] },
    mermaid: { theme: { light: 'neutral', dark: 'dark' } },
  } satisfies Preset.ThemeConfig,
};

export default config;
