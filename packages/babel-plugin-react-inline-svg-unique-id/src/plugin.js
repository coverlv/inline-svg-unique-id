import template from '@babel/template';
import jsxSyntaxPlugin from '@babel/plugin-syntax-jsx';

const idGeneratorLibraryName = 'react';
const idGeneratorHookName = 'useId';
const idValueVariableName = '__useId';

const idAttributeName = 'id';

const idRegex = '#([a-zA-Z][\\w:.-]*)'; // Matches ID: #example
const idExactMatchRegex = new RegExp(`^${idRegex}$`);

const iriRegex = `url\\(${idRegex}\\)`; // Matches SVG IRI: url(#example)
const iriExactMatchRegex = new RegExp(`^${iriRegex}$`);
const iriGlobalMatchRegex = new RegExp(iriRegex, 'g');

const svgIdentifiers = {
  svg: ['svg', 'Svg'],
  defs: ['defs', 'Defs'],
  style: ['style'],
};

const isSvgComponentIdentifier = (openingElementNameIdentifier, expectedSvgIdentifiers) =>
  expectedSvgIdentifiers.some((i) => openingElementNameIdentifier.isJSXIdentifier({ name: i }));

const isSvgComponentPath = (path, expectedSvgIdentifiers) =>
  isSvgComponentIdentifier(path.get('openingElement.name'), expectedSvgIdentifiers);

const isSvgPath = (path) => isSvgComponentPath(path, svgIdentifiers.svg);

const isDefsPath = (path) => isSvgComponentPath(path, svgIdentifiers.defs);

const isStylePath = (path) => isSvgComponentPath(path, svgIdentifiers.style);

const isIdAttribute = (attribute) => attribute.get('name').isJSXIdentifier({ name: idAttributeName });

const isStringLiteralAttribute = (attribute) => attribute.get('value').isStringLiteral();

const createIriUrl = (id) => `url(#${id})`;

const isXlinkHrefAttribute = (attribute) => {
  const nameNode = attribute.get('name');

  return (
    nameNode.isJSXIdentifier({ name: 'xlinkHref' }) ||
    (nameNode.isJSXNamespacedName() && nameNode.node.namespace.name === 'xlink' && nameNode.node.name.name === 'href')
  );
};

const createIdValuesContainer = (createIdIdentifier) => {
  const idIdentifierByIdValueMap = new Map();

  return {
    createIdIdentifier: (idValue) => {
      if (idIdentifierByIdValueMap.has(idValue)) {
        return idIdentifierByIdValueMap.get(idValue);
      }

      const newIdentifier = createIdIdentifier();

      idIdentifierByIdValueMap.set(idValue, newIdentifier);

      return newIdentifier;
    },
    getIdIdentifier: (idValue) => idIdentifierByIdValueMap.get(idValue),
    hasIdentifiers: () => idIdentifierByIdValueMap.size !== 0,
    getIdentifiers: () => Array.from(idIdentifierByIdValueMap.values()),
  };
};

const buildIdExpression = template.expression('`#${%%value%%}__${%%idIdentifier%%}`');
const idReferenceExpression = template.expression('`${%%value%%}__${%%idIdentifier%%}`');
const buildIriUrlExpression = template.expression(`\`${createIriUrl('${%%value%%}__${%%idIdentifier%%}')}\``);

const buildIdGeneratorHookImportStatement = template(
  `import { ${idGeneratorHookName} } from '${idGeneratorLibraryName}';`,
);

const buildIdIdentifierGeneratorStatement = template(`const %%idIdentifier%% = ${idGeneratorHookName}();`);

const plugin = ({ types: t }) => {
  const splitStylesStringByIriToLiterals = (stylesString, idValuesWithIdentifiers) =>
    idValuesWithIdentifiers
      .reduce(
        (splitStylesLiterals, [idValue, idIdentifier]) =>
          splitStylesLiterals.flatMap((stylesOrIdIdentifier) => {
            if (typeof stylesOrIdIdentifier !== 'string') {
              return stylesOrIdIdentifier;
            }

            const iriUrlExpression = buildIriUrlExpression({
              idIdentifier: idValueVariableName,
              value: t.stringLiteral(idValue),
            });

            return stylesOrIdIdentifier
              .split(createIriUrl(idValue))
              .flatMap((s, i, splits) => (i === splits.length - 1 ? [s] : [s, iriUrlExpression]));
          }),
        [stylesString],
      )
      .map((stylesOrIdIdentifier) =>
        typeof stylesOrIdIdentifier === 'string' ? t.stringLiteral(stylesOrIdIdentifier) : stylesOrIdIdentifier,
      );

  const jsxAttributeValue = (value) => t.jsxExpressionContainer(value);

  const updateAttributeIdReference = ({ attribute, idValueRegex, valueBuilder, idValuesContainer }) => {
    if (!isStringLiteralAttribute(attribute)) {
      return;
    }

    const idValueMatches = attribute.node.value.value.match(idValueRegex);

    if (!idValueMatches) {
      return;
    }

    const idIdentifier = idValuesContainer.getIdIdentifier(idValueMatches[1]);

    if (idIdentifier) {
      attribute.get('value').replaceWith(
        jsxAttributeValue(
          valueBuilder({
            idIdentifier: idValueVariableName,
            value: t.stringLiteral(idValueMatches[1]),
          }),
        ),
      );
    }
  };

  const svgDefsElementsIdIdentifiersCreatorVisitor = {
    JSXOpeningElement(path, state) {
      const idAttribute = path.get('attributes').find(isIdAttribute);

      if (!idAttribute || !isStringLiteralAttribute(idAttribute)) {
        return;
      }

      const newIdIdentifier = state.idValuesContainer.createIdIdentifier(idAttribute.node.value.value);

      idAttribute.get('value').replaceWith(
        jsxAttributeValue(
          idReferenceExpression({
            idIdentifier: idValueVariableName,
            value: t.stringLiteral(idAttribute.node.value.value),
          }),
        ),
      );
    },
  };

  const svgDefsElementsAttributesMapperVisitor = {
    JSXOpeningElement(path, state) {
      path.get('attributes').forEach((attribute) => {
        if (!isIdAttribute(attribute)) {
          updateAttributeIdReference({
            attribute,
            valueBuilder: buildIdExpression,
            idValueRegex: idExactMatchRegex,
            idValuesContainer: state.idValuesContainer,
          });
        }
      });
    },
  };

  const svgDefsVisitor = {
    JSXElement(path, state) {
      if (isDefsPath(path)) {
        // path.traverse(svgDefsElementsIdIdentifiersCreatorVisitor, state);
        path.traverse(svgDefsElementsAttributesMapperVisitor, state);
      }
      // all element's id should include useId()
      path.traverse(svgDefsElementsIdIdentifiersCreatorVisitor, state);
    },
  };

  const styleTagsUpdateVisitor = {
    StringLiteral(path, state) {
      const stylesString = path.node.value;
      const iriMatches = new Set(Array.from(stylesString.matchAll(iriGlobalMatchRegex)).map((x) => x[1]));
      const idValuesWithIdentifiers = Array.from(iriMatches)
        .map((idValue) => [idValue, state.idValuesContainer.getIdIdentifier(idValue)])
        .filter(([, idIdentifier]) => idIdentifier);

      if (idValuesWithIdentifiers.length === 0) {
        return;
      }

      const stylesStringLiterals = splitStylesStringByIriToLiterals(stylesString, idValuesWithIdentifiers);
      const concatenatedStyles = stylesStringLiterals.reduce((node, styleLiteral) =>
        node ? t.binaryExpression('+', node, styleLiteral) : styleLiteral,
      );

      path.replaceWith(concatenatedStyles);
    },
  };

  const svgElementsVisitor = {
    JSXElement(path, state) {
      if (isStylePath(path)) {
        path.traverse(styleTagsUpdateVisitor, state);
      }
    },
    JSXOpeningElement(path, state) {
      path.get('attributes').forEach((attribute) => {
        updateAttributeIdReference({
          attribute,
          valueBuilder: buildIriUrlExpression,
          idValueRegex: iriExactMatchRegex,
          idValuesContainer: state.idValuesContainer,
        });

        if (isXlinkHrefAttribute(attribute)) {
          updateAttributeIdReference({
            attribute,
            valueBuilder: buildIdExpression,
            idValueRegex: idExactMatchRegex,
            idValuesContainer: state.idValuesContainer,
          });
        }
      });
    },
  };

  const renderedJsxVisitor = {
    JSXElement(path, state) {
      if (isSvgPath(path)) {
        path.traverse(svgDefsVisitor, state);
        path.traverse(svgElementsVisitor, state);
      }
    },
  };

  const componentVisitor = {
    Function(path) {
      const idValuesContainer = createIdValuesContainer(() => path.scope.generateUidIdentifier(idAttributeName));

      path.traverse(renderedJsxVisitor, { idValuesContainer });

      if (!idValuesContainer.hasIdentifiers()) {
        return;
      }

      // If component is an arrow function with implicit return, add return statement
      if (path.isArrowFunctionExpression()) {
        path.arrowFunctionToExpression();
      }

      const body = path.get('body');
      const rootPath = path.findParent((p) => p.isProgram());

      rootPath.unshiftContainer('body', buildIdGeneratorHookImportStatement());

      if (idValuesContainer.getIdentifiers().length) {
        body.unshiftContainer('body', buildIdIdentifierGeneratorStatement({ idIdentifier: idValueVariableName }));
      }
    },
  };

  return {
    inherits: jsxSyntaxPlugin,
    visitor: componentVisitor,
  };
};

export default plugin;
