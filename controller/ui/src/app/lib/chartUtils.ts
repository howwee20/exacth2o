/**
 * Utility functions for working with charts and graph exports
 */


/**
 * A helper to color the lines based on sensorId.
 */
export function getSensorColor(index: number): string {
  const colors = [
    '#1f77b4',   // Steel Blue
    '#ff7f0e',   // Safety Orange
    '#2ca02c',   // Forest Green
    '#d62728',   // Crimson Red
    '#9467bd',   // Medium Purple
    '#8c564b',   // Brown
    '#e377c2',   // Pink
    '#17becf',   // Cyan
    '#bcbd22',   // Olive
    '#7f7f7f',   // Gray
    '#e6550d',   // Burnt Orange
    '#31a354',   // Sea Green
    '#756bb1',   // Slate Purple
    '#006d2c',   // Dark Green
    '#00796b'    // Teal
  ]
  return colors[index % colors.length]
}

/**
 * Downloads a chart element as an image
 * @param chartRef - DOM reference to the chart container
 * @param fileName - Name for the downloaded file (without extension)
 * @param selectedSensors - Array of selected sensor IDs to display in the legend
 */
export function downloadChartAsImage(
  chartRef: HTMLElement | null,
  fileName: string = 'chart',
  selectedSensors: number[] = [],
  selectedSensorsToPairingNameMap: Map<number, string> = new Map()
): void {
  if (!chartRef) {
    console.error('Chart reference not found');
    return;
  }

  try {
    // Get the SVG element inside the chart container
    const svgElement = chartRef.querySelector('svg');
    if (!svgElement) {
      console.error('SVG element not found in chart');
      return;
    }

    // Create a clone of the SVG element to avoid modifying the displayed one
    const svgClone = svgElement.cloneNode(true) as SVGElement;

    // Get the computed styles
    const computedStyle = getComputedStyle(svgElement);

    // Set explicit width and height on the cloned SVG
    svgClone.setAttribute('width', computedStyle.width);
    svgClone.setAttribute('height', computedStyle.height);

    // Convert SVG to XML string
    const svgData = new XMLSerializer().serializeToString(svgClone);

    // Create a Blob from the SVG data
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });

    // Create an Image object
    const img = new Image();

    // Handle image load event
    img.onload = () => {
      // Create a canvas element
      const canvas = document.createElement('canvas');

      // Get the dimensions from the SVG
      const svgWidth = parseFloat(computedStyle.width);
      const svgHeight = parseFloat(computedStyle.height);

      // Calculate legend height based on number of sensors - ensure enough space
      const legendPadding = 50; // Top and bottom padding for legend
      const legendItemHeight = 30; // Height per legend item
      const legendHeight = selectedSensors.length > 0
        ? legendPadding + (selectedSensors.length * legendItemHeight)
        : 0;

      // Set canvas dimensions (including space for legend)
      canvas.width = svgWidth;
      canvas.height = svgHeight + legendHeight;

      // Get canvas context and draw the image
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        console.error('Failed to get canvas context');
        return;
      }

      // Fill with white background
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw the chart image
      ctx.drawImage(img, 0, 0);

      // Add legend if we have selected sensors
      if (selectedSensors.length > 0) {
        // Draw legend title
        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = '#000000';
        ctx.fillText('Legend', 20, svgHeight + 30);

        // Draw legend entries
        ctx.font = '14px Arial';

        selectedSensors.forEach((sensorId, index) => {
          const y = svgHeight + 60 + (index * legendItemHeight);
          const color = getSensorColor(index);

          // Draw color box
          ctx.fillStyle = color;
          ctx.fillRect(20, y - 12, 16, 16);

          // Draw sensor ID text
          ctx.fillStyle = '#000000';
          ctx.fillText(`${selectedSensorsToPairingNameMap.get(sensorId) ?? `Sensor ${sensorId}`}`, 50, y);
        });

        // Draw border around legend
        ctx.strokeStyle = '#CCCCCC';
        ctx.lineWidth = 1;
        ctx.strokeRect(10, svgHeight + 10, canvas.width - 20, legendHeight - 20);
      }

      // Convert canvas to PNG
      canvas.toBlob((blob) => {
        if (!blob) {
          console.error('Failed to create image blob');
          return;
        }

        // Create download link
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${fileName}-${new Date().toISOString().split('T')[0]}.png`;
        document.body.appendChild(link);

        // Trigger download
        link.click();

        // Clean up
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 'image/png');
    };

    // Set the image source to the SVG blob URL
    img.src = URL.createObjectURL(svgBlob);
  } catch (error) {
    console.error('Error downloading chart as image:', error);
  }
}