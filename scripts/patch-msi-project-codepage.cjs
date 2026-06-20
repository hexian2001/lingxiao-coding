const fs = require('fs');

module.exports.default = async function patchMsiProjectCodepage(projectFile) {
  let xml = fs.readFileSync(projectFile, 'utf8');
  xml = xml.replace(
    /<Product\s+([^>]*?)>/,
    (_match, attrs) => {
      let nextAttrs = attrs
        .replace(/\bLanguage="[^"]*"/, 'Language="2052"')
        .replace(/\bCodepage="[^"]*"/, 'Codepage="936"');

      if (!/\bLanguage=/.test(nextAttrs)) {
        nextAttrs = `${nextAttrs} Language="2052"`;
      }

      if (!/\bCodepage=/.test(nextAttrs)) {
        nextAttrs = `${nextAttrs} Codepage="936"`;
      }

      return `<Product ${nextAttrs}>`;
    },
  );
  xml = xml.replace(
    /<Package\s+([^>]*?)\/>/,
    (_match, attrs) => {
      const nextAttrs = /\bSummaryCodepage=/.test(attrs)
        ? attrs.replace(/\bSummaryCodepage="[^"]*"/, 'SummaryCodepage="936"')
        : `${attrs} SummaryCodepage="936"`;

      return `<Package ${nextAttrs}/>`;
    },
  );
  fs.writeFileSync(projectFile, xml, 'utf8');
};
