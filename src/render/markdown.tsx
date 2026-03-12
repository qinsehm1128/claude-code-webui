import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";

export default function MDContent({ text }: { text: string }) {
  return (
    <div className="min-w-0 overflow-hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeHighlight]}
        components={{
          h1: (props) => <h1 className="mt-4 text-xl font-semibold text-ink-900" {...props} />,
          h2: (props) => <h2 className="mt-4 text-lg font-semibold text-ink-900" {...props} />,
          h3: (props) => <h3 className="mt-3 text-base font-semibold text-ink-800" {...props} />,
          p: (props) => <p className="mt-2 text-base leading-relaxed text-ink-700 break-words" {...props} />,
          ul: (props) => <ul className="mt-2 ml-4 grid list-disc gap-1" {...props} />,
          ol: (props) => <ol className="mt-2 ml-4 grid list-decimal gap-1" {...props} />,
          li: (props) => <li className="text-ink-700 break-words" {...props} />,
          strong: (props) => <strong className="text-ink-900 font-semibold" {...props} />,
          em: (props) => <em className="text-ink-800" {...props} />,
          pre: (props) => (
            <pre
              className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-surface-tertiary p-3 text-sm text-ink-700"
              {...props}
            />
          ),
          code: (props) => {
            const { children, className, node, ...rest } = props;
            const match = /language-(\w+)/.exec(className || "");
            const isInline = !match && !String(children).includes("\n");

            return isInline ? (
              <code className="rounded bg-surface-tertiary px-1.5 py-0.5 text-accent font-mono text-base break-all" {...rest}>
                {children}
              </code>
            ) : (
              <code className={`${className} font-mono`} {...rest}>
                {children}
              </code>
            );
          }
        }}
      >
        {String(text ?? "")}
      </ReactMarkdown>
    </div>
  )
}
