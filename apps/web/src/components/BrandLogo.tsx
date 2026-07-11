type BrandLogoProps = {
  className?: string;
  roundedClassName?: string;
  alt?: string;
};

/** Shared Nexara mark used in chrome, install UI, and loading states. */
export function BrandLogo({
  className = "h-12 w-12",
  roundedClassName = "rounded-2xl",
  alt = "Nexara",
}: BrandLogoProps) {
  return (
    <img
      src="/icons/icon-192.png"
      alt={alt}
      width={192}
      height={192}
      decoding="async"
      className={`${roundedClassName} shadow-lg shadow-sky-500/20 ${className}`}
    />
  );
}
