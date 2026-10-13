import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;

/** Reflection keeps the distributable helper independent of proprietary Element libraries. */
public final class NativeXbslAst {
    private static final int MAX_SOURCE_BYTES = 1024 * 1024;
    private static final int MAX_NODES = 50000;
    private static final int MAX_DEPTH = 256;
    private static final int MAX_JSON_CHARS = 8 * 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
    private static final String MODEL = "com.e1c.g5rt.xbsl.language.model.";
    private final Method parse;
    private final Method hasErrors;
    private final Method getErrors;
    private final Method getNode;
    private final Method eClass;
    private final Method eContents;
    private final Method eContainingFeature;
    private final Method eGet;
    private final Method getName;
    private final Method getAttributes;
    private final Method getStart;
    private final Method getEnd;
    private final Class<?> astNode;
    private final Class<?> enumerator;
    private final Method enumLiteral;
    private int nodes;
    private int sourceLength;
    private String sourceText;
    private int[] lineStarts;
    private final IdentityHashMap<Object, Boolean> visited = new IdentityHashMap<>();

    private NativeXbslAst() throws Exception {
        parse = Class.forName("com.e1c.g5rt.xbsl.language.parser.BslParserHelper").getMethod("parse", String.class);
        Class<?> result = Class.forName("com.e1c.g5rt.xbsl.language.parser.ParsingResult");
        hasErrors = result.getMethod("hasErrors");
        getErrors = result.getMethod("getErrors");
        getNode = result.getMethod("getNodeUnchecked");
        Class<?> object = Class.forName("org.eclipse.emf.ecore.EObject");
        Class<?> feature = Class.forName("org.eclipse.emf.ecore.EStructuralFeature");
        eClass = object.getMethod("eClass");
        eContents = object.getMethod("eContents");
        eContainingFeature = object.getMethod("eContainingFeature");
        eGet = object.getMethod("eGet", feature, boolean.class);
        getName = Class.forName("org.eclipse.emf.ecore.ENamedElement").getMethod("getName");
        getAttributes = Class.forName("org.eclipse.emf.ecore.EClass").getMethod("getEAllAttributes");
        astNode = Class.forName(MODEL + "AstNode");
        Class<?> util = Class.forName(MODEL + "AstUtil");
        getStart = util.getMethod("getStartPosition", astNode);
        getEnd = util.getMethod("getStopPosition", astNode);
        enumerator = Class.forName("org.eclipse.emf.common.util.Enumerator");
        enumLiteral = enumerator.getMethod("getLiteral");
    }

    public static void main(String[] args) throws Exception {
        PrintStream protocol = System.out;
        // Parser dependencies may log to stdout. Keep that output outside the protocol.
        System.setOut(System.err);
        NativeXbslAst helper;
        try {
            helper = new NativeXbslAst();
        } catch (Throwable error) {
            protocol.println("{\"id\":0,\"status\":\"unavailable\",\"code\":\"parser_api_unavailable\"}");
            protocol.flush();
            return;
        }
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = readLine(reader)) != null) {
            long id = 0;
            String response;
            try {
                int separator = line.indexOf('\t');
                if (separator <= 0) throw new IllegalArgumentException("invalid_frame");
                id = Long.parseLong(line.substring(0, separator));
                byte[] bytes = Base64.getDecoder().decode(line.substring(separator + 1));
                if (bytes.length > MAX_SOURCE_BYTES) throw new LimitException();
                response = helper.parse(id, new String(bytes, StandardCharsets.UTF_8));
                if (response.getBytes(StandardCharsets.UTF_8).length > MAX_RESPONSE_BYTES) throw new LimitException();
            } catch (Throwable error) {
                Throwable cause = error instanceof InvocationTargetException ? error.getCause() : error;
                String code = cause instanceof LimitException ? "ast_limit" : "parser_failed";
                response = "{\"id\":" + id + ",\"status\":\"error\",\"code\":\"" + code + "\"}";
            } finally {
                helper.visited.clear();
                helper.sourceText = null;
            }
            protocol.println(response);
            protocol.flush();
        }
    }

    private static String readLine(BufferedReader reader) throws Exception {
        StringBuilder line = new StringBuilder();
        int next;
        while ((next = reader.read()) != -1) {
            if (next == '\n') return line.toString();
            line.append((char) next);
            if (line.length() > MAX_SOURCE_BYTES * 4 / 3 + 128) throw new LimitException();
        }
        return line.length() == 0 ? null : line.toString();
    }

    private String parse(long id, String source) throws Exception {
        sourceText = source;
        sourceLength = source.length();
        nodes = 0;
        List<Integer> starts = new ArrayList<>();
        starts.add(0);
        for (int i = 0; i < source.length(); i++) if (source.charAt(i) == '\n') starts.add(i + 1);
        lineStarts = starts.stream().mapToInt(Integer::intValue).toArray();
        Object result = parse.invoke(null, source);
        Object root = getNode.invoke(result);
        boolean partial = Boolean.TRUE.equals(hasErrors.invoke(result));
        StringBuilder json = new StringBuilder("{\"id\":" + id + ",\"status\":\"ready\",\"partial\":" + partial
            + ",\"semanticBound\":false,\"referencesExcluded\":true,\"root\":");
        if (root == null) json.append("null"); else node(json, root, 0);
        json.append(",\"nodeCount\":").append(nodes).append(",\"diagnostics\":[");
        boolean first = true;
        for (Object error : partial ? (Iterable<?>) getErrors.invoke(result) : Collections.emptyList()) {
            if (!first) json.append(',');
            first = false;
            json.append('{');
            String[] names = { "message", "code", "line", "column", "endLine", "endColumn", "startOffset", "endOffset" };
            String[] getters = { "getMessage", "getCode", "getLine", "getColumn", "getEndLine", "getEndColumn", "getStartPos", "getEndPos" };
            for (int i = 0; i < names.length; i++) {
                if (i > 0) json.append(',');
                quote(json, names[i]);
                json.append(':');
                value(json, error.getClass().getMethod(getters[i]).invoke(error));
            }
            json.append('}');
            checkSize(json);
        }
        return json.append("]}").toString();
    }

    private void node(StringBuilder json, Object node, int depth) throws Exception {
        if (++nodes > MAX_NODES || depth > MAX_DEPTH || visited.put(node, true) != null) throw new LimitException();
        Object type = eClass.invoke(node);
        String kind = (String) getName.invoke(type);
        int start = -1;
        int end = -1;
        if (astNode.isInstance(node)) {
            try {
                start = (Integer) getStart.invoke(null, node);
                end = (Integer) getEnd.invoke(null, node);
            } catch (InvocationTargetException ignored) {
                // Recovery nodes can lack a source position; retain them with an explicit sentinel.
            }
        }
        if (start < 0 || end < start || end > sourceLength) { start = -1; end = -1; }
        json.append("{\"kind\":");
        quote(json, kind);
        json.append(",\"startOffset\":").append(start).append(",\"endOffset\":").append(end);
        json.append(",\"startLine\":").append(lineAt(start)).append(",\"endLine\":").append(lineAt(end > start ? end - 1 : end));
        Object containment = eContainingFeature.invoke(node);
        if (containment != null) {
            json.append(",\"role\":");
            quote(json, (String) getName.invoke(containment));
        }
        json.append(",\"attributes\":{");
        List<String> omitted = new ArrayList<>();
        String literalValueType = null;
        boolean first = true;
        for (Object attribute : (Iterable<?>) getAttributes.invoke(type)) {
            String name = (String) getName.invoke(attribute);
            Object attributeValue = eGet.invoke(node, attribute, false);
            if (kind.startsWith("Literal") && name.equals("value") && attributeValue != null
                && !(attributeValue instanceof String) && !(attributeValue instanceof Number) && !(attributeValue instanceof Boolean)) {
                literalValueType = attributeValue.getClass().getName();
            }
            if (!plain(attributeValue)) { omitted.add(name); continue; }
            if (!first) json.append(',');
            first = false;
            quote(json, name);
            json.append(':');
            value(json, attributeValue);
        }
        json.append("},\"omittedAttributes\":");
        value(json, omitted);
        if (literalValueType != null) {
            json.append(",\"attributeValueTypes\":{\"value\":");
            quote(json, literalValueType);
            json.append('}');
            if (start >= 0) {
                json.append(",\"attributeSources\":{\"value\":");
                quote(json, sourceText.substring(start, end));
                json.append('}');
            }
        }
        json.append(",\"children\":[");
        first = true;
        for (Object child : (Iterable<?>) eContents.invoke(node)) {
            if (!first) json.append(',');
            first = false;
            node(json, child, depth + 1);
        }
        json.append("]}");
        checkSize(json);
    }

    private int lineAt(int offset) {
        if (offset < 0) return 0;
        int low = 0;
        int high = lineStarts.length - 1;
        while (low <= high) {
            int middle = (low + high) >>> 1;
            if (lineStarts[middle] <= offset) low = middle + 1; else high = middle - 1;
        }
        return high + 1;
    }

    private boolean plain(Object value) {
        if (value == null || value instanceof String || value instanceof Boolean || value instanceof Number
            || value instanceof Enum<?> || value instanceof java.time.Duration || enumerator.isInstance(value)) return true;
        if (value instanceof List<?>) {
            for (Object item : (List<?>) value) {
                if (item instanceof List<?> || !plain(item)) return false;
            }
            return true;
        }
        return false;
    }

    private void value(StringBuilder json, Object value) throws Exception {
        if (value == null) json.append("null");
        else if (value instanceof Boolean || value instanceof Number) {
            String text = value.toString();
            // XBSL decimals can exceed JavaScript precision; preserve their exact value.
            if (value instanceof java.math.BigDecimal || value instanceof java.math.BigInteger
                || (value instanceof Long && Math.abs(((Long) value).doubleValue()) > 9007199254740991d)
                || text.equals("NaN") || text.contains("Infinity")) quote(json, text);
            else json.append(text);
        } else if (value instanceof List<?>) {
            json.append('[');
            boolean first = true;
            for (Object item : (List<?>) value) {
                if (!first) json.append(',');
                first = false;
                value(json, item);
            }
            json.append(']');
        } else if (value instanceof java.time.Duration) quote(json, ((java.time.Duration) value).toString());
        else if (enumerator.isInstance(value)) quote(json, (String) enumLiteral.invoke(value));
        else quote(json, value.toString());
        checkSize(json);
    }

    private static void quote(StringBuilder json, String value) {
        json.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') json.append('\\').append(c);
            else if (c == '\n') json.append("\\n");
            else if (c == '\r') json.append("\\r");
            else if (c == '\t') json.append("\\t");
            else if (c < 32) json.append(String.format("\\u%04x", (int) c));
            else json.append(c);
        }
        json.append('"');
    }

    private static void checkSize(StringBuilder json) throws LimitException {
        if (json.length() > MAX_JSON_CHARS) throw new LimitException();
    }

    private static final class LimitException extends Exception {}
}
