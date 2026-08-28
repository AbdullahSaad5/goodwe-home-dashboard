import { describe, expect, it, vi } from 'vitest';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { chartAnimationOptions, chartUpdateOptions } from './DashboardComponents';

echarts.use([SVGRenderer]);

describe('chart refresh state', () => {
  it('updates chart series without replacing the user-controlled zoom component', () => {
    expect(chartUpdateOptions()).toEqual({
      notMerge: false,
      lazyUpdate: true,
    });
  });

  it('does not replay line drawing when a time selection remounts the chart', () => {
    expect(chartAnimationOptions(false)).toEqual({
      animation: false,
      animationDuration: 0,
      animationDurationUpdate: 0,
    });
  });

  it('allows charts without time controls to opt into a one-time entrance animation', () => {
    expect(chartAnimationOptions(false, true)).toMatchObject({
      animation: true,
      animationDuration: 320,
      animationDurationUpdate: 0,
    });
  });

  it('keeps the active ECharts zoom window when new points arrive', () => {
    const canvasContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ measureText: (value: string) => ({ width: value.length * 7 }) } as never);
    const chart = echarts.init(null, undefined, {
      renderer: 'svg',
      ssr: true,
      width: 800,
      height: 400,
    });
    const option = (data: Array<[number, number]>): echarts.EChartsCoreOption => ({
      xAxis: { type: 'time' },
      yAxis: { type: 'value' },
      dataZoom: [{ type: 'inside' }],
      series: [{ name: 'Solar', type: 'line', data }],
    });

    chart.setOption(
      option([
        [1, 10],
        [2, 20],
        [3, 30],
      ]),
    );
    chart.setOption({ dataZoom: [{ start: 35, end: 70 }] });

    chart.setOption(
      option([
        [1, 10],
        [2, 20],
        [3, 30],
        [4, 40],
      ]),
      chartUpdateOptions(),
    );

    const zoom = (chart.getOption().dataZoom as Array<{ start: number; end: number }>)[0];
    expect(zoom).toMatchObject({ start: 35, end: 70 });
    chart.dispose();
    canvasContext.mockRestore();
  });
});
